"""
ShieldNet — Test End-to-End complet (A -> Z)
=============================================
Scenario :
  1.  Auth JWT
  2.  Init noeud local
  3.  Reset + Seed 100 pairs
  4.  Verify status & capacity
  5.  Enregistrer un pair manuel
  6.  Heartbeat
  7.  Decouvrir les pairs
  8.  Alert (detection d'attaque DDoS)
  9.  Selection WSM des pairs
  10. Demande d'aide (help request)
  11. Acceptation de session
  12. Redirection trafic
  13. Verification sessions actives
  14. Cloture attaque
  15. Recalcul PeerTrust
  16. Enregistrer une violation
  17. Logs audit

Usage : python tests/e2e_test.py
"""

import asyncio
import aiohttp
import json
import sys

BASE_URL = "https://localhost:3001/api/v1"
NODE_ID  = "node-university"
SECRET   = "shieldnet-secret-key-2025"
SSL      = False   # ignore self-signed cert

GREEN  = "\033[92m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
RESET  = "\033[0m"

def ok(msg):   print(f"  {GREEN}[OK]{RESET}  {msg}")
def err(msg):  print(f"  {RED}[ERR]{RESET} {msg}")
def info(msg): print(f"  {YELLOW}---{RESET}  {msg}")
def step(n, msg): print(f"\n{CYAN}ETAPE {n:02d}{RESET} — {msg}")


async def get_token(session):
    async with session.post(
        f"{BASE_URL}/auth/token",
        json={"node_id": NODE_ID, "node_secret": SECRET},
        ssl=SSL,
    ) as r:
        d = await r.json()
        token = d.get("token")
        if not token:
            raise RuntimeError(f"Token non obtenu : {d}")
        return token


def headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


async def run():
    errors = []
    ctx = {}   # stocke les IDs pour les etapes suivantes

    connector = aiohttp.TCPConnector(ssl=False)
    async with aiohttp.ClientSession(connector=connector) as s:

        # ------------------------------------------------------------------ #
        step(1, "Authentification JWT")
        try:
            ctx["token"] = await get_token(s)
            ok(f"Token obtenu (RS256)")
        except Exception as e:
            err(str(e)); errors.append("Auth"); return errors

        H = headers(ctx["token"])

        # ------------------------------------------------------------------ #
        step(2, "Reset de la base de donnees")
        async with s.post(f"{BASE_URL}/simulation/reset", headers=H, ssl=SSL) as r:
            if r.status in (200, 201, 204):
                ok("Base remise a zero")
            else:
                txt = await r.text(); err(f"HTTP {r.status} — {txt}"); errors.append("Reset")

        # Re-auth apres reset (tables recrees)
        ctx["token"] = await get_token(s)
        H = headers(ctx["token"])

        # ------------------------------------------------------------------ #
        step(3, "Initialisation du noeud local")
        payload = {
            "node_name": "ESI Alger",
            "organization_name": "ESI Alger",
            "organization_type": "UNIVERSITY",
            "country_code": "DZ",
            "api_endpoint_url": "https://localhost:3001/api/v1",
            "public_key": "LOCAL_KEY_ESI",
            "max_scrubbing_capacity_gbps": 10,
            "current_load_percent": 30,
        }
        async with s.post(f"{BASE_URL}/simulation/node/init", headers=H, json=payload, ssl=SSL) as r:
            d = await r.json()
            if r.status in (200, 201):
                ok(f"Noeud initialise : {d.get('node_name', d.get('node_id', ''))}")
            else:
                err(f"HTTP {r.status} — {d}"); errors.append("NodeInit")

        # ------------------------------------------------------------------ #
        step(4, "Verification status & capacite")
        async with s.get(f"{BASE_URL}/status", headers=H, ssl=SSL) as r:
            d = await r.json()
            if r.status == 200:
                ok(f"Status={d.get('status')}  load={d.get('current_load_pct')}%  available={d.get('available_gbps')} Gbps")
            else:
                err(f"HTTP {r.status} — {d}"); errors.append("Status")

        async with s.get(f"{BASE_URL}/capacity", headers=H, ssl=SSL) as r:
            d = await r.json()
            if r.status == 200:
                ok(f"Capacite max={d.get('max_scrubbing_capacity_gbps')} Gbps  disponible={d.get('available_gbps')} Gbps")
            else:
                err(f"HTTP {r.status} — {d}"); errors.append("Capacity")

        # ------------------------------------------------------------------ #
        step(5, "Injection de 100 pairs virtuels (seed)")
        async with s.post(
            f"{BASE_URL}/simulation/seed-peers", headers=H, ssl=SSL,
            timeout=aiohttp.ClientTimeout(total=90),
        ) as r:
            d = await r.json()
            if r.status in (200, 201):
                dist = d.get("distribution", {})
                ok("Pairs injectes : " + "  ".join(f"{k}={v}" for k, v in dist.items()))
            else:
                err(f"HTTP {r.status} — {d}"); errors.append("Seed")

        ctx["token"] = await get_token(s)
        H = headers(ctx["token"])

        # ------------------------------------------------------------------ #
        step(6, "Enregistrement d'un pair manuel")
        payload = {
            "peer_name": "node-datacenter",
            "organization_name": "DataCenter Oran",
            "organization_type": "DATACENTER",
            "country_code": "DZ",
            "api_endpoint_url": "https://localhost:3004/api/v1",
            "public_key": "PEER_KEY_DC_ORAN",
            "max_scrubbing_capacity_gbps": 20,
            "declared_available_gbps": 15,
            "capabilities": [{"declared_capacity_gbps": 15, "verified": False}],
        }
        async with s.post(f"{BASE_URL}/peers/register", headers=H, json=payload, ssl=SSL) as r:
            d = await r.json()
            if r.status in (200, 201):
                ctx["peer_id"] = d.get("peer_id")
                ok(f"Pair enregistre : {d.get('peer_name')}  id={ctx['peer_id'][:8]}...")
            else:
                err(f"HTTP {r.status} — {d}"); errors.append("PeerRegister")

        # ------------------------------------------------------------------ #
        step(7, "Heartbeat du pair manuel")
        if ctx.get("peer_id"):
            payload = {
                "peer_id": ctx["peer_id"],
                "reported_status": "ACTIVE",
                "reported_load_pct": 20,
                "reported_available_gbps": 15,
                "round_trip_time_ms": 12,
            }
            async with s.post(f"{BASE_URL}/heartbeat", headers=H, json=payload, ssl=SSL) as r:
                if r.status in (200, 201):
                    ok("Heartbeat enregistre")
                else:
                    d = await r.json(); err(f"HTTP {r.status} — {d}"); errors.append("Heartbeat")

        # ------------------------------------------------------------------ #
        step(8, "Decouverte des pairs actifs")
        async with s.post(
            f"{BASE_URL}/peers/discover", headers=H,
            json={"max_results": 5}, ssl=SSL,
        ) as r:
            d = await r.json()
            if r.status == 200:
                ok(f"{d.get('count', 0)} pairs decouverts")
            else:
                err(f"HTTP {r.status} — {d}"); errors.append("Discover")

        ctx["token"] = await get_token(s)
        H = headers(ctx["token"])

        # ------------------------------------------------------------------ #
        step(9, "Alerte DDoS (signal de la boite de detection)")
        payload = {
            "overflow_volume_gbps": 8,
            "local_capacity_at_detection": 7,
            "target_ip_range": "10.0.1.0/24",
            "target_service": "HTTP",
            "target_port": 80,
            "target_protocol": "TCP",
        }
        async with s.post(f"{BASE_URL}/alert", headers=H, json=payload, ssl=SSL) as r:
            d = await r.json()
            if r.status in (200, 201):
                ctx["attack_id"] = d.get("attack_id")
                ok(f"Attaque creee : id={ctx['attack_id'][:8]}...  status={d.get('status')}")
                info(f"overflow={d.get('overflow_volume_gbps')} Gbps  target={d.get('target_ip_range')}")
            else:
                err(f"HTTP {r.status} — {d}"); errors.append("Alert")

        # ------------------------------------------------------------------ #
        step(10, "Selection WSM des pairs (formule 4.7-4.8)")
        async with s.post(
            f"{BASE_URL}/trust/select-peers", headers=H,
            json={"overflow_gbps": 8, "min_trust_score": 0.4}, ssl=SSL,
        ) as r:
            d = await r.json()
            if r.status == 200:
                selected = d.get("selected_peers", [])
                ok(f"{len(selected)} pairs selectionnes par WSM")
                for p in selected[:3]:
                    info(f"  {p.get('peer_name','?'):<20} wsm={p.get('wsm_score',0):.3f}  alloc={p.get('allocation_pct',0):.1f}%")
                if selected:
                    ctx["wsm_peer_id"] = selected[0].get("peer_id")
            else:
                err(f"HTTP {r.status} — {d}"); errors.append("WSM")

        ctx["token"] = await get_token(s)
        H = headers(ctx["token"])

        # ------------------------------------------------------------------ #
        step(11, "Demande d'aide au pair selectionne")
        if ctx.get("attack_id") and ctx.get("wsm_peer_id"):
            payload = {
                "attack_id": ctx["attack_id"],
                "helping_peer_id": ctx["wsm_peer_id"],
                "allocation_pct": 60,
            }
            async with s.post(f"{BASE_URL}/help/request", headers=H, json=payload, ssl=SSL) as r:
                d = await r.json()
                if r.status in (200, 201):
                    ctx["session_id"] = d.get("session_id")
                    ok(f"Session creee : id={ctx['session_id'][:8]}...  status={d.get('status')}")
                else:
                    err(f"HTTP {r.status} — {d}"); errors.append("HelpRequest")
        else:
            info("Etape sautee (pas d'attaque ou de pair WSM)")

        # ------------------------------------------------------------------ #
        step(12, "Acceptation de la session d'aide")
        if ctx.get("session_id"):
            payload = {
                "accepted_volume_gbps": 5,
                "tunnel_type": "GRE",
                "response_time_ms": 40,
            }
            url = f"{BASE_URL}/help/{ctx['session_id']}/accept"
            async with s.put(url, headers=H, json=payload, ssl=SSL) as r:
                d = await r.json()
                if r.status == 200:
                    ok(f"Session acceptee : status={d.get('status')}  tunnel={payload['tunnel_type']}")
                else:
                    err(f"HTTP {r.status} — {d}"); errors.append("HelpAccept")

        ctx["token"] = await get_token(s)
        H = headers(ctx["token"])

        # ------------------------------------------------------------------ #
        step(13, "Redirection du trafic")
        if ctx.get("session_id"):
            payload = {
                "session_id": ctx["session_id"],
                "tunnel_type": "GRE",
                "volume_gbps": 5,
            }
            async with s.post(f"{BASE_URL}/traffic/redirect", headers=H, json=payload, ssl=SSL) as r:
                d = await r.json()
                if r.status in (200, 201):
                    ok(f"Trafic redirige : session status={d.get('status')}")
                else:
                    err(f"HTTP {r.status} — {d}"); errors.append("Redirect")

        # ------------------------------------------------------------------ #
        step(14, "Verification des sessions actives")
        async with s.get(f"{BASE_URL}/sessions/active", headers=H, ssl=SSL) as r:
            d = await r.json()
            sessions = d if isinstance(d, list) else d.get("sessions", [])
            ok(f"{len(sessions)} session(s) active(s)")
            for sess in sessions[:2]:
                info(f"  session={str(sess.get('session_id',''))[:8]}...  status={sess.get('status')}")

        # ------------------------------------------------------------------ #
        step(15, "Cloture de l'attaque")
        if ctx.get("attack_id"):
            payload = {
                "attack_id": ctx["attack_id"],
                "session_ids": [ctx["session_id"]] if ctx.get("session_id") else [],
                "attack_duration_seconds": 180,
            }
            async with s.post(f"{BASE_URL}/attack/over", headers=H, json=payload, ssl=SSL) as r:
                d = await r.json()
                if r.status in (200, 201):
                    atk = d.get("attack", d)
                    ok(f"Attaque cloturee : severity={atk.get('severity')}  status={atk.get('status')}")
                else:
                    err(f"HTTP {r.status} — {d}"); errors.append("AttackOver")

        ctx["token"] = await get_token(s)
        H = headers(ctx["token"])

        # ------------------------------------------------------------------ #
        step(16, "Recalcul PeerTrust du pair selectionne")
        if ctx.get("wsm_peer_id"):
            url = f"{BASE_URL}/trust/{ctx['wsm_peer_id']}/recalculate"
            async with s.post(url, headers=H, ssl=SSL) as r:
                d = await r.json()
                if r.status == 200:
                    ok(f"Score recalcule : {d.get('overall_score', '?')}  niveau={d.get('trust_level', '?')}")
                else:
                    err(f"HTTP {r.status} — {d}"); errors.append("Recalculate")

        # ------------------------------------------------------------------ #
        step(17, "Enregistrement d'une violation (pair defaillant)")
        if ctx.get("peer_id"):
            payload = {
                "violation_type": "BROKEN_PROMISE",
                "severity": "MAJOR",
                "description": "Pair a accepte 5 Gbps mais n a filtre que 0.5 Gbps",
                "sanction_applied": "TEMP_SUSPENSION",
            }
            url = f"{BASE_URL}/trust/{ctx['peer_id']}/violation"
            async with s.post(url, headers=H, json=payload, ssl=SSL) as r:
                d = await r.json()
                if r.status in (200, 201):
                    ok(f"Violation enregistree : {payload['violation_type']}")
                else:
                    err(f"HTTP {r.status} — {d}"); errors.append("Violation")

        # ------------------------------------------------------------------ #
        step(18, "Logs d'audit (5 derniers evenements)")
        async with s.get(f"{BASE_URL}/logs/audit?limit=5", headers=H, ssl=SSL) as r:
            d = await r.json()
            events = d.get("events", [])
            ok(f"{d.get('total', len(events))} evenements au total")
            for e in events[:5]:
                info(f"  [{e.get('severity')}] {e.get('event_type')} — {e.get('description', '')[:60]}")

        # ------------------------------------------------------------------ #
        step(19, "Metriques finales du noeud")
        async with s.get(f"{BASE_URL}/metrics", headers=H, ssl=SSL) as r:
            d = await r.json()
            if r.status == 200:
                ok(
                    f"peers={d.get('connected_peers')}  "
                    f"active={d.get('active_peers')}  "
                    f"sessions={d.get('active_sessions')}  "
                    f"attacks={d.get('total_attacks')}  "
                    f"load={d.get('current_load_pct')}%"
                )

    # ---------------------------------------------------------------------- #
    print("\n" + "=" * 55)
    if errors:
        print(f"{RED}ECHECS ({len(errors)}) : {', '.join(errors)}{RESET}")
        return 1
    else:
        print(f"")
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
