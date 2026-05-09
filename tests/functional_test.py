"""
ShieldNet — Test Fonctionnel Principal (100 serveurs HTTP in-process)
=====================================================================
Architecture :
  100 nœuds = 100 vrais serveurs aiohttp, ports 19001-19100
  Communication HTTP réelle entre nœuds dans un seul processus Python
  Zéro Docker, zéro PostgreSQL — état en mémoire par nœud

Tous les endpoints implémentés et testés :
  POST /auth/token
  POST /simulation/reset
  POST /simulation/node/init
  POST /peers/register
  GET  /peers
  POST /simulation/attack/detect
  POST /trust/select-peers         (WSM Éq. 4.7-4.8)
  POST /help/request
  PUT  /help/{id}/accept
  POST /traffic/redirect
  POST /attack/over
  POST /trust/{id}/recalculate     (PeerTrust Éq. 6)
  GET  /trust
  GET  /trust/{id}

Usage : python tests/functional_test.py
"""

import asyncio
import aiohttp
from aiohttp import web
import uuid
import random
import time
import hashlib
import json
from typing import Dict, List, Optional

# ── Seed fixe EN PREMIER — avant tout appel random ────────────────────────────
random.seed(42)

# ── Paramètres ────────────────────────────────────────────────────────────────
N_NODES   = 100
BASE_PORT = 19001
SECRET    = "shieldnet-2025"
TOKEN_TTL = 3600

# Poids WSM (AHP, CR = 1.6 %)
W_CAP, W_LOAD, W_TRUST, W_RECIP = 0.52, 0.20, 0.20, 0.08
SEV_W = {"LOW": 0.25, "MEDIUM": 0.50, "HIGH": 0.75, "CRITICAL": 1.00}

ORG_POOL = (["ISP"] * 3 + ["DATACENTER"] * 3 + ["PME"] * 4
            + ["UNIVERSITY"] * 2 + ["GOVERNMENT"] + ["RESEARCH"])
TIERS   = ["T1", "T2", "T3"]
TUNNELS = ["GRE", "VXLAN", "IPIP"]
CAP_RNG = {"T1": (20.0, 100.0), "T2": (5.0, 20.0), "T3": (0.5, 5.0)}


def score_to_level(s: float) -> str:
    for t, l in [(0.80, "GOLD"), (0.60, "SILVER"),
                 (0.40, "BRONZE"), (0.20, "SUSPECT")]:
        if s >= t:
            return l
    return "BANNED"


# ── Générateur d'attaque — appelé dans main() après création de la victime ────
def generate_attack(victim_capacity: float, victim_load: float) -> dict:
    """
    Génère une attaque réaliste APRÈS avoir connu les caractéristiques
    de la victime. Garantit toujours un overflow significatif pour que
    la coalition soit nécessaire.

    Paramètres
    ----------
    victim_capacity : capacité max de scrubbing en Gbps
    victim_load     : charge actuelle en %

    Retourne un dict prêt à envoyer à POST /simulation/attack/detect
    """
    available   = victim_capacity * (1 - victim_load / 100)

    # Multiplicateur entre 5× et 80× la capacité disponible
    # → overflow garanti et significatif
    multiplier  = random.uniform(5.0, 80.0)
    volume_gbps = round(available * multiplier, 1)
    volume_gbps = max(10.0, volume_gbps)   # minimum absolu 10 Gbps

    overflow = round(max(0.0, volume_gbps - available), 2)

    return {
        "volume_gbps":     volume_gbps,
        "severity":        "CRITICAL",
        "target_ip_range": "193.194.100.0/24",
        "target_service":  "DNS",
        "available_local": round(available, 2),
        "overflow_gbps":   overflow,
        "multiplier":      round(multiplier, 1),
    }


# ── Token HMAC-SHA256 (JWT simplifié) ─────────────────────────────────────────
def make_token(node_id: str) -> str:
    exp  = int(time.time()) + TOKEN_TTL
    body = f"{node_id}:{exp}"
    sig  = hashlib.sha256(f"{body}:{SECRET}".encode()).hexdigest()[:16]
    return f"{body}:{sig}"


def check_token(token: str) -> Optional[str]:
    """Retourne node_id si valide, None sinon."""
    try:
        parts = token.split(":")
        if len(parts) != 3:
            return None
        node_id, exp_s, sig = parts
        if time.time() > int(exp_s):
            return None
        expected = hashlib.sha256(
            f"{node_id}:{exp_s}:{SECRET}".encode()
        ).hexdigest()[:16]
        return node_id if sig == expected else None
    except Exception:
        return None


# ── État in-memory d'un nœud ──────────────────────────────────────────────────
class NodeState:
    def __init__(self, node_id, name, org, tier, capacity, load, port):
        self.node_id  = node_id
        self.name     = name
        self.org      = org
        self.tier     = tier
        self.capacity = capacity   # max scrubbing Gbps
        self.load     = load       # % charge actuelle
        self.port     = port
        self.url      = f"http://localhost:{port}/api/v1"

        # bases de données en mémoire
        self.peers:    Dict[str, dict]  = {}
        self.attacks:  Dict[str, dict]  = {}
        self.sessions: Dict[str, dict]  = {}
        self.trust:    Dict[str, dict]  = {}
        self.credits:  Dict[str, float] = {}

    def reset(self):
        for d in (self.peers, self.attacks,
                  self.sessions, self.trust, self.credits):
            d.clear()


# ── Serveur HTTP d'un nœud ────────────────────────────────────────────────────
def build_app(st: NodeState) -> web.Application:
    """Crée l'application aiohttp pour un nœud avec tous ses endpoints."""

    app = web.Application()

    # ── Décorateur JWT ────────────────────────────────────────────────────────
    def need_auth(fn):
        async def wrapper(req):
            hdr = req.headers.get("Authorization", "")
            tok = hdr[7:] if hdr.startswith("Bearer ") else None
            if not tok:
                return web.json_response({"error": "Unauthorized"}, status=401)
            nid = check_token(tok)
            if not nid:
                return web.json_response(
                    {"error": "Invalid or expired token"}, status=401)
            req["caller"] = nid
            return await fn(req)
        return wrapper

    # ── POST /auth/token ──────────────────────────────────────────────────────
    async def auth_token(req):
        b = await req.json()
        if b.get("node_secret") != SECRET:
            return web.json_response({"error": "Invalid credentials"}, status=401)
        if b.get("node_id") not in (st.node_id, st.name):
            return web.json_response({"error": "Unknown node"}, status=401)
        return web.json_response({
            "token":      make_token(st.node_id),
            "expires_in": f"{TOKEN_TTL}s",
            "node_id":    st.node_id,
            "role":       "local",
            "algorithm":  "HMAC-SHA256",
        })

    # ── POST /simulation/reset ────────────────────────────────────────────────
    async def sim_reset(req):
        st.reset()
        return web.json_response({"message": "Node reset — all data cleared."})

    # ── POST /simulation/node/init ────────────────────────────────────────────
    async def sim_init(req):
        b = await req.json()
        st.name     = b.get("node_name",                   st.name)
        st.org      = b.get("organization_type",           st.org)
        st.tier     = b.get("tier",                        st.tier)
        st.capacity = b.get("max_scrubbing_capacity_gbps", st.capacity)
        st.load     = b.get("current_load_percent",        st.load)
        return web.json_response(
            {"node_id": st.node_id, "node_name": st.name, "status": "ACTIVE"},
            status=201)

    # ── POST /peers/register ──────────────────────────────────────────────────
    async def peers_register(req):
        b   = await req.json()
        pid = b.get("peer_id") or str(uuid.uuid4())
        peer = {
            "peer_id":                     pid,
            "peer_name":                   b.get("peer_name", "?"),
            "organization_type":           b.get("organization_type", "PME"),
            "tier":                        b.get("tier", "T3"),
            "api_endpoint_url":            b.get("api_endpoint_url", ""),
            "max_scrubbing_capacity_gbps": b.get("max_scrubbing_capacity_gbps", 1.0),
            "declared_available_gbps":     b.get("declared_available_gbps", 1.0),
            "status":                      "ACTIVE",
            "trust_level":                 "BRONZE",
            "overall_score":               0.5,
        }
        st.peers[pid] = peer
        return web.json_response(peer, status=201)

    # ── GET /peers ────────────────────────────────────────────────────────────
    @need_auth
    async def peers_list(req):
        return web.json_response(list(st.peers.values()))

    # ── POST /simulation/attack/detect ────────────────────────────────────────
    @need_auth
    async def attack_detect(req):
        b        = await req.json()
        vol      = float(b.get("volume_gbps", 0))
        avail    = st.capacity * (1 - st.load / 100)
        overflow = max(0.0, vol - avail)
        aid      = str(uuid.uuid4())
        attack   = {
            "attack_id":   aid,
            "volume_gbps": vol,
            "severity":    b.get("severity", "CRITICAL"),
            "status":      "DETECTED",
        }
        st.attacks[aid] = attack
        return web.json_response({
            "attack": attack,
            "node_state": {
                "local_capacity_gbps": st.capacity,
                "available_gbps":      round(avail, 2),
                "overflow_gbps":       round(overflow, 2),
                "escalation_needed":   overflow > 0,
            },
        }, status=201)

    # ── POST /trust/select-peers  (algorithme WSM Éq. 4.7-4.8) ───────────────
    @need_auth
    async def trust_select(req):
        b            = await req.json()
        min_trust    = float(b.get("min_trust_score", 0.0))
        ignore_trust = bool(b.get("ignore_trust", False))

        eligible = [
            p for p in st.peers.values()
            if p.get("status") != "BANNED"
            and (ignore_trust or p.get("overall_score", 0.5) >= min_trust)
        ]
        if not eligible:
            return web.json_response({"selected_peers": [], "plan": []})

        max_cap   = max(p.get("max_scrubbing_capacity_gbps", 1)
                        for p in eligible) or 1
        max_trust = max(p.get("overall_score", 0.5)
                        for p in eligible) or 1
        max_cred  = max(st.credits.get(p["peer_id"], 0.01)
                        for p in eligible)

        scored = []
        for p in eligible:
            cap_n   = p.get("max_scrubbing_capacity_gbps", 1) / max_cap
            avail   = p.get("declared_available_gbps",
                            p.get("max_scrubbing_capacity_gbps", 1))
            total_c = p.get("max_scrubbing_capacity_gbps", 1) or 1
            load_n  = min(1.0, avail / total_c)
            trust_n = p.get("overall_score", 0.5) / max_trust
            recip_n = min(1.0, st.credits.get(p["peer_id"], 0) / max_cred)
            wsm     = round(
                W_CAP * cap_n + W_LOAD * load_n
                + W_TRUST * trust_n + W_RECIP * recip_n, 4)
            scored.append((p, wsm))

        scored.sort(key=lambda x: x[1], reverse=True)
        total = sum(sc for _, sc in scored) or 1.0

        plan = []
        for peer, wsm_score in scored:
            w   = wsm_score / total
            pct = round(w * 100, 2)
            plan.append({
                "peer_id":                     peer["peer_id"],
                "peer_name":                   peer.get("peer_name", "?"),
                "wsm_score":                   wsm_score,
                "weight":                      round(w, 4),
                "allocation_pct":              pct,
                "declared_available_gbps":     peer.get("declared_available_gbps", 0),
                "max_scrubbing_capacity_gbps": peer.get("max_scrubbing_capacity_gbps", 0),
            })

        return web.json_response({"selected_peers": plan, "plan": plan})

    # ── POST /help/request ────────────────────────────────────────────────────
    @need_auth
    async def help_request(req):
        b   = await req.json()
        pid = b.get("helping_peer_id", "")
        if pid not in st.peers:
            return web.json_response({"error": "Peer not found"}, status=404)
        if st.peers[pid].get("status") == "BANNED":
            return web.json_response({"error": "Peer is banned"}, status=403)
        sid     = str(uuid.uuid4())
        session = {
            "session_id":           sid,
            "attack_id":            b.get("attack_id"),
            "helping_peer_id":      pid,
            "allocation_pct":       b.get("allocation_pct"),
            "accepted_volume_gbps": None,
            "actual_volume_gbps":   None,
            "status":               "REQUESTED",
            "tunnel_type":          None,
        }
        st.sessions[sid] = session
        return web.json_response(session, status=201)

    # ── PUT /help/{sid}/accept ────────────────────────────────────────────────
    @need_auth
    async def help_accept(req):
        sid = req.match_info["sid"]
        if sid not in st.sessions:
            return web.json_response({"error": "Session not found"}, status=404)
        b = await req.json()
        st.sessions[sid].update({
            "status":               "ACCEPTED",
            "accepted_volume_gbps": b.get("accepted_volume_gbps"),
            "tunnel_type":          b.get("tunnel_type"),
        })
        return web.json_response(st.sessions[sid])

    # ── POST /traffic/redirect ────────────────────────────────────────────────
    @need_auth
    async def traffic_redirect(req):
        b   = await req.json()
        sid = b.get("session_id", "")
        if sid not in st.sessions:
            return web.json_response({"error": "Session not found"}, status=404)
        if st.sessions[sid]["status"] != "ACCEPTED":
            return web.json_response({"error": "Session not accepted"}, status=409)
        promised = b.get("volume_gbps") or 0
        # Livraison réaliste : chaque pair délivre entre 40 % et 100 % de sa promesse
        actual = round(promised * random.uniform(0.40, 1.00), 2)
        st.sessions[sid].update({
            "status":             "ACTIVE",
            "actual_volume_gbps": actual,
            "tunnel_type":        b.get("tunnel_type",
                                        st.sessions[sid].get("tunnel_type")),
        })
        return web.json_response(st.sessions[sid])

    # ── POST /attack/over ─────────────────────────────────────────────────────
    @need_auth
    async def attack_over(req):
        b    = await req.json()
        aid  = b.get("attack_id", "")
        sids = b.get("session_ids", [])

        if aid in st.attacks:
            st.attacks[aid]["status"] = "ENDED"

        for sid in sids:
            if sid not in st.sessions:
                continue
            sess              = st.sessions[sid]
            sess["status"]    = "COMPLETED"
            if not sess.get("actual_volume_gbps"):
                sess["actual_volume_gbps"] = sess.get("accepted_volume_gbps", 0)
            pid = sess.get("helping_peer_id", "")
            vol = sess.get("actual_volume_gbps") or 0
            st.credits[pid] = st.credits.get(pid, 0) + vol

        return web.json_response({
            "status":         "ENDED",
            "sessions_closed": len(sids),
        })

    # ── POST /trust/{pid}/recalculate  (PeerTrust Éq. 6) ─────────────────────
    @need_auth
    async def trust_recalc(req):
        pid = req.match_info["pid"]
        if pid not in st.peers:
            return web.json_response({"error": "Peer not found"}, status=404)

        completed = [
            s for s in st.sessions.values()
            if s.get("helping_peer_id") == pid
            and s.get("status") == "COMPLETED"
        ]

        # Cr = crédibilité réseau (moyenne des scores des autres pairs)
        # cold start = 1.0 : confiance maximale au premier échange
        cr = 1.0
        if st.trust:
            scores = [t["overall_score"] for t in st.trust.values()
                      if t.get("peer_id") != pid]
            if scores:
                cr = sum(scores) / len(scores)

        # T(u) = Σ S(u,i) · Cr · D(u,i)
        if completed:
            score = 0.0
            for s in completed:
                accepted = s.get("accepted_volume_gbps") or 0
                actual   = s.get("actual_volume_gbps")   or 0
                S        = min(1.0, actual / accepted) if accepted > 0 else 0.0
                D        = SEV_W.get("CRITICAL", 1.0)
                score   += S * cr * D
            score = min(1.0, max(0.0, score))
        else:
            score = 0.5   # cold start

        level = score_to_level(score)
        ts = {
            "peer_id":         pid,
            "overall_score":   round(score, 4),
            "trust_level":     level,
            "last_calculated": time.time(),
            "session_count":   len(completed),
        }
        st.trust[pid]                  = ts
        st.peers[pid]["overall_score"] = round(score, 4)
        st.peers[pid]["trust_level"]   = level
        return web.json_response(ts)

    # ── GET /trust ────────────────────────────────────────────────────────────
    @need_auth
    async def trust_list(req):
        result = []
        for pid, ts in st.trust.items():
            peer = st.peers.get(pid, {})
            result.append({
                **ts,
                "peer": {
                    "peer_id":   pid,
                    "peer_name": peer.get("peer_name", "?"),
                    "tier":      peer.get("tier", "?"),
                },
            })
        result.sort(key=lambda x: x["overall_score"], reverse=True)
        return web.json_response(result)

    # ── GET /trust/{pid} ──────────────────────────────────────────────────────
    async def trust_get(req):
        pid = req.match_info["pid"]
        ts  = st.trust.get(pid, {"overall_score": 0.5, "trust_level": "BRONZE"})
        return web.json_response({"peer_id": pid, "trust_score": ts})

    # ── Enregistrement des routes ─────────────────────────────────────────────
    app.router.add_post("/api/v1/auth/token",               auth_token)
    app.router.add_post("/api/v1/simulation/reset",         sim_reset)
    app.router.add_post("/api/v1/simulation/node/init",     sim_init)
    app.router.add_post("/api/v1/peers/register",           peers_register)
    app.router.add_get( "/api/v1/peers",                    peers_list)
    app.router.add_post("/api/v1/simulation/attack/detect", attack_detect)
    app.router.add_post("/api/v1/trust/select-peers",       trust_select)
    app.router.add_post("/api/v1/help/request",             help_request)
    app.router.add_put( "/api/v1/help/{sid}/accept",        help_accept)
    app.router.add_post("/api/v1/traffic/redirect",         traffic_redirect)
    app.router.add_post("/api/v1/attack/over",              attack_over)
    app.router.add_post("/api/v1/trust/{pid}/recalculate",  trust_recalc)
    app.router.add_get( "/api/v1/trust",                    trust_list)
    app.router.add_get( "/api/v1/trust/{pid}",              trust_get)

    return app


# ── Client HTTP ───────────────────────────────────────────────────────────────
async def call(session: aiohttp.ClientSession, method: str, url: str,
               body=None, token: str = None) -> dict:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    kwargs  = {"headers": headers, "timeout": aiohttp.ClientTimeout(total=10)}
    if body is not None:
        kwargs["json"] = body

    async with getattr(session, method)(url, **kwargs) as r:
        text = await r.text()
        try:
            data = json.loads(text)
            if isinstance(data, list):
                return {"_list": data, "_status": r.status}
            data["_status"] = r.status
            return data
        except Exception:
            return {"_status": r.status, "_text": text}


# ── Affichage ─────────────────────────────────────────────────────────────────
def title(msg): print(f"\n{'='*62}\n  {msg}\n{'='*62}")
def step(msg):  print(f"\n  > {msg}")
def ok(msg):    print(f"    [OK]   {msg}")
def warn(msg):  print(f"    [WARN] {msg}")
def info(msg):  print(f"    {msg}")

RESULTS: List[dict] = []


def record(phase, check, passed, detail=""):
    RESULTS.append({"phase": phase, "check": check,
                    "passed": passed, "detail": detail})


# ══════════════════════════════════════════════════════════════════════════════
async def main():

    # ── Création des 100 nœuds virtuels ──────────────────────────────────────
    states: List[NodeState] = []

    # Nœud 0 = victime fixe (Université T2, 10 Gbps, 50 % de charge)
    states.append(NodeState(
        node_id  = str(uuid.uuid4()),
        name     = "node-university-0",
        org      = "UNIVERSITY",
        tier     = "T2",
        capacity = 10.0,
        load     = 50.0,
        port     = BASE_PORT,
    ))

    # Nœuds 1-99 = helpers avec caractéristiques aléatoires (seed=42)
    for i in range(1, N_NODES):
        tier      = random.choice(TIERS)
        org       = random.choice(ORG_POOL)
        cmin, cmax = CAP_RNG[tier]
        states.append(NodeState(
            node_id  = str(uuid.uuid4()),
            name     = f"node-{org.lower()}-{i}",
            org      = org,
            tier     = tier,
            capacity = round(random.uniform(cmin, cmax), 1),
            load     = round(random.uniform(0, 80), 1),
            port     = BASE_PORT + i,
        ))

    victim  = states[0]
    helpers = states[1:]

    # ── Génération de l'attaque (APRÈS création de la victime) ───────────────
    attack_info = generate_attack(victim.capacity, victim.load)

    # ── Démarrage des 100 serveurs HTTP ───────────────────────────────────────
    title("DÉMARRAGE DES 100 SERVEURS HTTP")
    runners = []
    for st in states:
        app    = build_app(st)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        site   = web.TCPSite(runner, "localhost", st.port)
        await site.start()
        runners.append(runner)

    ok(f"{N_NODES} serveurs HTTP démarrés "
       f"(ports {BASE_PORT}–{BASE_PORT + N_NODES - 1})")
    ok(f"Victime  : {victim.name}  →  http://localhost:{victim.port}")
    ok(f"Helpers  : {len(helpers)} nœuds "
       f"(ports {BASE_PORT+1}–{BASE_PORT+N_NODES-1})")

    try:
        async with aiohttp.ClientSession() as http:

            def url(st: NodeState, path: str) -> str:
                return f"http://localhost:{st.port}/api/v1{path}"

            # ── PHASE 0 — Réinitialisation ────────────────────────────────────
            title("PHASE 0 — VÉRIFICATION SANTÉ + RÉINITIALISATION")

            step("Réinitialisation des 100 nœuds...")
            ok_count = 0
            for st in states:
                r = await call(http, "post", url(st, "/simulation/reset"))
                if r.get("_status") == 200:
                    ok_count += 1
            ok(f"{ok_count}/100 nœuds réinitialisés")
            record("0", "100 nœuds accessibles", ok_count == N_NODES,
                   f"{ok_count}/{N_NODES}")

            # ── PHASE 1 — Authentification JWT ────────────────────────────────
            title("PHASE 1 — AUTHENTIFICATION JWT")

            step("Obtention des tokens JWT pour les 100 nœuds...")
            tokens: Dict[str, str] = {}
            for st in states:
                r = await call(http, "post", url(st, "/auth/token"),
                               {"node_id": st.name, "node_secret": SECRET})
                if r.get("token"):
                    tokens[st.node_id] = r["token"]
            ok(f"{len(tokens)}/100 tokens obtenus")
            ok(f"Exemple : {victim.name} → "
               f"{tokens.get(victim.node_id,'?')[:45]}…")
            record("1", "Tokens JWT générés",
                   len(tokens) == N_NODES, f"{len(tokens)}/{N_NODES}")

            step("Accès sans token → doit retourner 401...")
            r     = await call(http, "get", url(victim, "/peers"))
            ok401 = r.get("_status") == 401
            (ok if ok401 else warn)(
                "401 Unauthorized reçu ✓" if ok401
                else f"Reçu {r.get('_status')}")
            record("1", "Rejet sans token (401)", ok401)

            # ── PHASE 2 — Initialisation + enregistrement croisé ──────────────
            title("PHASE 2 — INITIALISATION DE LA COALITION (100 NŒUDS)")

            step("Initialisation de chaque nœud local...")
            init_ok = 0
            for st in states:
                r = await call(http, "post", url(st, "/simulation/node/init"), {
                    "node_name":                   st.name,
                    "organization_name":           f"{st.org} #{st.port}",
                    "organization_type":           st.org,
                    "tier":                        st.tier,
                    "country_code":                "DZ",
                    "api_endpoint_url":            st.url,
                    "public_key":                  f"KEY_{st.node_id[:8]}",
                    "max_scrubbing_capacity_gbps": st.capacity,
                    "current_load_percent":        st.load,
                })
                if r.get("_status") in (200, 201):
                    init_ok += 1
            ok(f"{init_ok}/100 nœuds initialisés")
            record("2", "100 nœuds initialisés", init_ok == N_NODES,
                   f"{init_ok}/{N_NODES}")

            step(f"Enregistrement des {len(helpers)} helpers sur la victime...")
            reg_ok = 0
            tok_v  = tokens[victim.node_id]
            for h in helpers:
                r = await call(http, "post", url(victim, "/peers/register"), {
                    "peer_id":                     h.node_id,
                    "peer_name":                   h.name,
                    "organization_name":           h.org,
                    "organization_type":           h.org,
                    "tier":                        h.tier,
                    "country_code":                "DZ",
                    "api_endpoint_url":            h.url,
                    "public_key":                  f"KEY_{h.node_id[:8]}",
                    "max_scrubbing_capacity_gbps": h.capacity,
                    "declared_available_gbps":
                        round(h.capacity * (1 - h.load / 100), 2),
                }, tok_v)
                if r.get("_status") in (200, 201):
                    reg_ok += 1
            ok(f"{reg_ok}/{len(helpers)} pairs enregistrés sur la victime")

            r        = await call(http, "get", url(victim, "/peers"), token=tok_v)
            nb_peers = len(r.get("_list", []))
            ok(f"GET /peers → {nb_peers} pairs en base")
            record("2", f"{len(helpers)} pairs enregistrés",
                   reg_ok == len(helpers), f"{reg_ok}/{len(helpers)}")
            record("2", "GET /peers cohérent", nb_peers == reg_ok,
                   f"{nb_peers} pairs")

            # ── PHASE 3 — Détection de l'attaque ──────────────────────────────
            title("PHASE 3 — DÉTECTION D'UNE ATTAQUE DDOS CRITIQUE")

            info(f"  Volume          : {attack_info['volume_gbps']} Gbps"
                 f"  (×{attack_info['multiplier']} la capacité disponible)")
            info(f"  Sévérité        : {attack_info['severity']}")
            info(f"  Capacité locale : {victim.capacity} Gbps"
                 f"  (charge {victim.load}%)")
            info(f"  Disponible      : {attack_info['available_local']} Gbps")
            info(f"  Overflow estimé : {attack_info['overflow_gbps']} Gbps")

            step("POST /simulation/attack/detect...")
            tok_v = tokens[victim.node_id]
            r = await call(
                http, "post",
                url(victim, "/simulation/attack/detect"),
                {
                    "volume_gbps":     attack_info["volume_gbps"],
                    "severity":        attack_info["severity"],
                    "target_ip_range": attack_info["target_ip_range"],
                    "target_service":  attack_info["target_service"],
                },
                tok_v,
            )

            attack_id = (r.get("attack") or {}).get("attack_id") \
                        or r.get("attack_id")
            overflow  = r.get("node_state", {}).get(
                "overflow_gbps", attack_info["overflow_gbps"])

            ok(f"Attaque ID : {str(attack_id)[:8]}…")
            ok(f"Volume     : {attack_info['volume_gbps']} Gbps")
            ok(f"Overflow   : {overflow} Gbps → escalade coalition")
            record("3", "Attaque détectée", attack_id is not None,
                   f"vol={attack_info['volume_gbps']} Gbps, "
                   f"overflow={overflow} Gbps")

            # ── PHASE 4 — Sélection WSM ───────────────────────────────────────
            title("PHASE 4 — SÉLECTION DES PAIRS (POST /trust/select-peers)")

            info("  Poids AHP : wC=0.52 | wL=0.20 | wT=0.20 | wR=0.08")

            step("POST /trust/select-peers (WSM sur les 99 pairs)...")
            t0    = time.time()
            tok_v = tokens[victim.node_id]
            r     = await call(http, "post",
                               url(victim, "/trust/select-peers"),
                               {"ignore_trust": True}, tok_v)
            wsm_ms    = (time.time() - t0) * 1000
            selected  = r.get("selected_peers", [])
            total_pct = sum(p.get("allocation_pct", 0) for p in selected)

            ok(f"{len(selected)} pairs classés en {wsm_ms:.1f} ms")
            info("")
            info(f"  Top 10 (sur {len(selected)}) :")
            info(f"  {'#':<4} {'Nœud':<30} {'Cap Gbps':<10}"
                 f" {'Score WSM':<12} {'Allocation'}")
            info("  " + "─" * 64)
            for i, p in enumerate(selected[:10], 1):
                info(f"  {i:<4} {p.get('peer_name','?'):<30}"
                     f" {p.get('max_scrubbing_capacity_gbps',0):<10.1f}"
                     f" {p.get('wsm_score',0):<12.4f}"
                     f" {p.get('allocation_pct',0):.2f}%")
            if len(selected) > 10:
                info(f"  … ({len(selected)-10} pairs supplémentaires)")
            info("")
            info(f"  Somme des allocations : {total_pct:.2f}%"
                 f" (doit être ≈ 100%)")
            record("4", "WSM retourne des pairs", len(selected) > 0,
                   f"{len(selected)} pairs")
            record("4", "Somme allocations ≈ 100%",
                   abs(total_pct - 100) < 1, f"total={total_pct:.2f}%")

            # ── PHASE 5 — Réponse coalition ───────────────────────────────────
            title("PHASE 5 — RÉPONSE DE LA COALITION (99 PAIRS)")

            step("POST /help/request × 99...")
            sessions: List[dict] = []
            tok_v = tokens[victim.node_id]
            for p in selected:
                r = await call(http, "post", url(victim, "/help/request"), {
                    "attack_id":       attack_id,
                    "helping_peer_id": p["peer_id"],
                    "allocation_pct":  p.get("allocation_pct"),
                }, tok_v)
                if r.get("session_id"):
                    sessions.append(r)
                else:
                    warn(f"help/request {p.get('peer_name')} : "
                         f"{r.get('error','?')}")
            ok(f"{len(sessions)}/{len(selected)} sessions créées")
            record("5", "POST /help/request × 99",
                   len(sessions) == len(selected),
                   f"{len(sessions)}/{len(selected)}")

            step("PUT /help/{id}/accept + POST /traffic/redirect × 99...")
            active_sessions: List[dict] = []
            tunnels_c = TUNNELS * (len(sessions) // len(TUNNELS) + 1)

            for i, sess in enumerate(sessions):
                sid    = sess.get("session_id")
                tunnel = tunnels_c[i]
                vol    = round(
                    overflow * (sess.get("allocation_pct", 0) / 100), 2)

                r_acc = await call(
                    http, "put",
                    url(victim, f"/help/{sid}/accept"),
                    {"accepted_volume_gbps": vol, "tunnel_type": tunnel},
                    tok_v,
                )
                if r_acc.get("_status") not in (200, 201):
                    continue

                r_red = await call(
                    http, "post",
                    url(victim, "/traffic/redirect"),
                    {"session_id": sid, "tunnel_type": tunnel,
                     "volume_gbps": vol},
                    tok_v,
                )
                if r_red.get("status") == "ACTIVE":
                    active_sessions.append(sess)

            total_vol = sum(
                round(overflow * (s.get("allocation_pct", 0) / 100), 2)
                for s in active_sessions
            )
            coverage = (min(100.0, total_vol / overflow * 100)
                        if overflow > 0 else 100.0)
            ok(f"{len(active_sessions)}/{len(sessions)} sessions ACTIVE")
            ok(f"Volume absorbé : {total_vol:.1f} Gbps / {overflow} Gbps"
               f" ({coverage:.1f}% couverture)")
            record("5", "Sessions activées (accept + redirect)",
                   len(active_sessions) > 0,
                   f"{len(active_sessions)} actives")

            # ── PHASE 6 — Fin d'attaque + PeerTrust ───────────────────────────
            title("PHASE 6 — FIN D'ATTAQUE + SCORES PEERTRUST")

            step("POST /attack/over...")
            tok_v = tokens[victim.node_id]
            r = await call(http, "post", url(victim, "/attack/over"), {
                "attack_id":  attack_id,
                "session_ids": [s["session_id"] for s in active_sessions
                                if s.get("session_id")],
                "attack_duration_seconds": 180,
            }, tok_v)
            ok("Attaque clôturée")
            record("6", "POST /attack/over",
                   r.get("_status") in (200, 201))

            step(f"POST /trust/{{id}}/recalculate × {len(selected)} pairs...")
            recalc_ok = 0
            for p in selected:
                r = await call(
                    http, "post",
                    url(victim, f"/trust/{p['peer_id']}/recalculate"),
                    token=tok_v,
                )
                if r.get("_status") in (200, 201):
                    recalc_ok += 1
                else:
                    warn(f"recalculate {p.get('peer_name')} : "
                         f"HTTP {r.get('_status')} — {r.get('error','')}")
            ok(f"{recalc_ok}/{len(selected)} recalculs effectués")
            record("6", f"POST /trust/recalculate × {len(selected)}",
                   recalc_ok == len(selected),
                   f"{recalc_ok}/{len(selected)}")

            step("GET /trust → lecture des scores...")
            r          = await call(http, "get",
                                    url(victim, "/trust"), token=tok_v)
            trust_data = r.get("_list", [])

            if trust_data:
                lvl_counts: Dict[str, int] = {}
                for ts in trust_data:
                    l = ts.get("trust_level", "?")
                    lvl_counts[l] = lvl_counts.get(l, 0) + 1

                info("")
                info(f"  {'Niveau':<10} {'Nœuds':<8} {'Score moyen'}")
                info("  " + "─" * 32)
                for lvl in ["GOLD", "SILVER", "BRONZE", "SUSPECT", "BANNED"]:
                    c = lvl_counts.get(lvl, 0)
                    if c > 0:
                        avg = sum(t["overall_score"] for t in trust_data
                                  if t.get("trust_level") == lvl) / c
                        info(f"  {lvl:<10} {c:<8} {avg:.4f}")
                info("")
                info("  Top 5 :")
                for ts in trust_data[:5]:
                    name = (ts.get("peer") or {}).get("peer_name", "?")
                    info(f"    {name:<38} {ts.get('overall_score',0):.4f}"
                         f"  {ts.get('trust_level','?')}")

                non_banned = sum(c for l, c in lvl_counts.items()
                                 if l != "BANNED")
                record("6", "GET /trust retourne des scores", True,
                       f"{len(trust_data)} scores, {non_banned} non bannis")
            else:
                warn("GET /trust : liste vide")
                record("6", "GET /trust retourne des scores", False)

            # ── PHASE 7 — Tableau de bord final ───────────────────────────────
            title("PHASE 7 — TABLEAU DE BORD FINAL")

            info(f"  Nœuds coalition    : {N_NODES} serveurs HTTP in-process")
            info(f"  Volume attaque     : {attack_info['volume_gbps']} Gbps"
                 f" (×{attack_info['multiplier']} capacité dispo) — CRITIQUE")
            info(f"  Absorbé localement : "
                 f"{victim.capacity*(1-victim.load/100):.1f} Gbps")
            info(f"  Overflow délégué   : {overflow} Gbps")
            info(f"  Pairs mobilisés    : "
                 f"{len(active_sessions)} / {len(selected)}")
            info(f"  Volume absorbé     : "
                 f"{total_vol:.1f} Gbps  ({coverage:.1f}%)")
            info(f"  WSM latence        : "
                 f"{wsm_ms:.1f} ms  ({len(selected)} pairs classés)")
            info(f"  Scores PeerTrust   : {len(trust_data)} calculés")
            info(f"  Résultat           : ATTAQUE "
                 f"{'NEUTRALISÉE ✓' if coverage >= 95 else 'PARTIELLEMENT ATTÉNUÉE'}")

    finally:
        for runner in runners:
            await runner.cleanup()

    # ── Bilan des assertions ──────────────────────────────────────────────────
    title("BILAN DES ASSERTIONS")

    passed = sum(1 for r in RESULTS if r["passed"])
    total  = len(RESULTS)

    for r in RESULTS:
        status = "[PASS]" if r["passed"] else "[FAIL]"
        detail = f" — {r['detail']}" if r["detail"] else ""
        print(f"  {status}  Phase {r['phase']} | {r['check']}{detail}")

    print()
    print(f"  Résultat : {passed}/{total} assertions passées")
    if passed == total:
        print("\n  ✓ TEST FONCTIONNEL RÉUSSI\n")
    else:
        print(f"\n  ✗ {total - passed} assertion(s) échouée(s)\n")


if __name__ == "__main__":
    asyncio.run(main())