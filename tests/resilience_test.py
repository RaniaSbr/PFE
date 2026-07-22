"""
ShieldNet — Test de résilience / chaos (reconsiderCoalition)
==============================================================
Valide que la coalition se reconfigure automatiquement quand un pair
aidant tombe en cours d'attaque, conformément à la nouvelle architecture :

  1. Détection (POST /alert, overflow déjà connu)
  2. Sollicitation broadcast (POST /help/request à TOUS les pairs ACTIVE,
     sans allocation ni volume — juste "peux-tu aider ?")
  3. Acceptation (les pairs déclarent eux-mêmes accepted_volume_gbps)
  4. Allocation WSM (POST /attack/{id}/allocate, calculée sur les seuls
     pairs ayant accepté)
  5. Activation (POST /traffic/redirect) d'un sous-ensemble de pairs
  6. CHAOS — deux pairs aidants actifs "tombent" (POST /peers/goodbye)
  7. Vérification : leurs sessions passent à FAILED, et reconsiderCoalition()
     sollicite automatiquement de nouveaux pairs pour combler le manque

Usage : python tests/resilience_test.py
"""

import asyncio
import aiohttp
import sys
import os
import csv

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False
    print("[WARN] matplotlib non installé — PNG ignoré (pip install matplotlib)")

BASE_URL = "https://localhost:3001/api/v1"
NODE_ID  = "node-university"
SECRET   = "shieldnet-secret-key-2025"
SSL      = False  # ignore le certificat auto-signé

CSV_PATH = os.path.join(os.path.dirname(__file__), "shieldnet_resilience.csv")
PNG_PATH = os.path.join(os.path.dirname(__file__), "shieldnet_resilience.png")

GREEN, RED, YELLOW, CYAN, RESET = "\033[92m", "\033[91m", "\033[93m", "\033[96m", "\033[0m"


async def snapshot(session, headers, attack_id):
    """Capture l'état courant de la couverture de la coalition pour cette attaque."""
    async with session.get(f"{BASE_URL}/attacks/{attack_id}", headers=headers, ssl=SSL) as r:
        attack = await r.json()
    hs = attack.get("help_sessions", [])
    active = [s for s in hs if s.get("status") == "ACTIVE"]
    secured = [s for s in hs if s.get("status") in ("ACCEPTED", "ACTIVE")]
    volume_active = sum(float(s.get("actual_volume_gbps") or 0) for s in active)
    volume_secured = sum(float(s.get("accepted_volume_gbps") or 0) for s in secured)
    return {
        "nb_active": len(active),
        "nb_secured": len(secured),
        "volume_active_gbps": round(volume_active, 2),
        "volume_secured_gbps": round(volume_secured, 2),
    }


def generate_png(rows):
    if not HAS_MATPLOTLIB:
        return
    labels = [r["label"] for r in rows]
    x = list(range(len(rows)))

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5))
    fig.suptitle("ShieldNet — Résilience de la coalition face à un chaos", fontweight="bold")

    axes[0].plot(x, [r["nb_active"] for r in rows], "o-", color="#1d6b47", label="Sessions ACTIVE")
    axes[0].plot(x, [r["nb_secured"] for r in rows], "s--", color="#1b2a5e", label="Sécurisées (ACCEPTED+ACTIVE)")
    axes[0].set_xticks(x); axes[0].set_xticklabels(labels, rotation=15)
    axes[0].set_title("Nombre de pairs aidants")
    axes[0].set_ylabel("pairs")
    axes[0].legend(); axes[0].grid(True, alpha=0.3)

    axes[1].plot(x, [r["volume_active_gbps"] for r in rows], "o-", color="#d62728", label="Volume ACTIVE (Gbps)")
    axes[1].plot(x, [r["volume_secured_gbps"] for r in rows], "s--", color="#aec7e8", label="Volume sécurisé (Gbps)")
    axes[1].set_xticks(x); axes[1].set_xticklabels(labels, rotation=15)
    axes[1].set_title("Volume couvert")
    axes[1].set_ylabel("Gbps")
    axes[1].legend(); axes[1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(PNG_PATH, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"\n  [OK] PNG généré → {PNG_PATH}")


def ok(msg):   print(f"  {GREEN}[OK]{RESET}  {msg}")
def err(msg):  print(f"  {RED}[ERR]{RESET} {msg}")
def info(msg): print(f"  {YELLOW}---{RESET}  {msg}")
def step(n, msg): print(f"\n{CYAN}ÉTAPE {n:02d}{RESET} — {msg}")


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
    connector = aiohttp.TCPConnector(ssl=False)
    async with aiohttp.ClientSession(connector=connector) as s:

        # ------------------------------------------------------------------ #
        step(1, "Authentification + réinitialisation")
        try:
            token = await get_token(s)
            H = headers(token)
        except Exception as e:
            err(str(e)); return [str(e)]

        async with s.post(f"{BASE_URL}/simulation/reset", headers=H, ssl=SSL) as r:
            ok("Base remise à zéro") if r.status in (200, 201, 204) else err(f"HTTP {r.status}")

        token = await get_token(s); H = headers(token)

        # ------------------------------------------------------------------ #
        step(2, "Initialisation du nœud local + 100 pairs virtuels")
        payload = {
            "node_name": "ESI Alger", "organization_name": "ESI Alger",
            "organization_type": "UNIVERSITY", "country_code": "DZ",
            "api_endpoint_url": "https://localhost:3001/api/v1",
            "public_key": "LOCAL_KEY_ESI",
            "max_scrubbing_capacity_gbps": 10, "current_load_percent": 30,
        }
        async with s.post(f"{BASE_URL}/simulation/node/init", headers=H, json=payload, ssl=SSL) as r:
            d = await r.json()
            ok(f"Nœud initialisé : {d.get('node_name')}") if r.status in (200, 201) else err(str(d))

        async with s.post(f"{BASE_URL}/simulation/seed-peers", headers=H, ssl=SSL,
                           timeout=aiohttp.ClientTimeout(total=90)) as r:
            d = await r.json()
            if r.status in (200, 201):
                ok(f"100 pairs créés — {d.get('distribution')}")
            else:
                err(str(d)); errors.append("seed-peers")

        token = await get_token(s); H = headers(token)

        # ------------------------------------------------------------------ #
        step(3, "Détection d'une attaque (overflow déjà connu)")
        async with s.post(f"{BASE_URL}/alert", headers=H, json={
            "peak_volume_gbps": 25, "overflow_volume_gbps": 15,
            "local_capacity_at_detection": 7, "target_ip_range": "10.0.5.0/24",
            "target_service": "HTTP", "target_protocol": "TCP",
        }, ssl=SSL) as r:
            d = await r.json()
            if r.status not in (200, 201):
                err(str(d)); return errors
            attack_id = d.get("attack_id")
            ok(f"Attaque créée : {attack_id[:8]}... | overflow=15 Gbps")

        # ------------------------------------------------------------------ #
        step(4, "Sollicitation broadcast — POST /help/request à tous les pairs ACTIVE")
        async with s.get(f"{BASE_URL}/peers", headers=H, ssl=SSL) as r:
            all_peers = await r.json()
        active_peers = [p for p in all_peers if p.get("status") == "ACTIVE"]
        info(f"{len(active_peers)} pairs ACTIVE à solliciter")

        sessions = []  # {peer_id, peer_name, session_id, status}
        for p in active_peers:
            async with s.post(f"{BASE_URL}/help/request", headers=H, json={
                "attack_id": attack_id, "helping_peer_id": p["peer_id"],
            }, ssl=SSL) as r:
                d = await r.json()
                if r.status in (200, 201):
                    sessions.append({
                        "peer_id": p["peer_id"], "peer_name": p.get("peer_name"),
                        "session_id": d.get("session_id"), "status": d.get("status"),
                        "accepted_volume_gbps": d.get("accepted_volume_gbps"),
                    })
        accepted = [s_ for s_ in sessions if s_["status"] == "ACCEPTED"]
        rejected = [s_ for s_ in sessions if s_["status"] == "REJECTED"]
        ok(f"{len(sessions)} sollicités — {len(accepted)} acceptés, {len(rejected)} refusés")
        if not accepted:
            err("Aucun pair n'a accepté — test interrompu"); return ["no_acceptance"]

        token = await get_token(s); H = headers(token)

        # ------------------------------------------------------------------ #
        step(5, "Allocation WSM — POST /attack/{id}/allocate (sur les seuls accepteurs)")
        async with s.post(f"{BASE_URL}/attack/{attack_id}/allocate", headers=H, ssl=SSL) as r:
            d = await r.json()
            if r.status != 200:
                err(str(d)); errors.append("allocate")
                plan = []
            else:
                plan = d.get("plan", [])
                ok(f"Plan calculé sur {len(plan)} pair(s) accepteur(s)")

        plan_by_peer = {p["peer"]["peer_id"]: p for p in plan}

        # ------------------------------------------------------------------ #
        step(6, "Activation — POST /traffic/redirect (5 premiers accepteurs)")
        activated = []
        for s_ in accepted[:5]:
            entry = plan_by_peer.get(s_["peer_id"], {})
            vol = entry.get("estimated_gbps") or s_.get("accepted_volume_gbps") or 1.0
            async with s.post(f"{BASE_URL}/traffic/redirect", headers=H, json={
                "session_id": s_["session_id"], "tunnel_type": "GRE", "volume_gbps": vol,
            }, ssl=SSL) as r:
                d = await r.json()
                if r.status in (200, 201) and d.get("status") == "ACTIVE":
                    activated.append(s_)
        ok(f"{len(activated)} session(s) ACTIVE")
        if len(activated) < 3:
            err("Pas assez de sessions actives pour un test de chaos significatif")
            errors.append("not_enough_active")

        token = await get_token(s); H = headers(token)

        snap_t0 = await snapshot(s, H, attack_id)
        info(f"T0 (avant chaos) : {snap_t0['nb_active']} ACTIVE, "
             f"{snap_t0['volume_active_gbps']} Gbps actifs")

        # ------------------------------------------------------------------ #
        step(7, "CHAOS — 2 pairs aidants actifs tombent (POST /peers/goodbye)")
        victims = activated[:2]
        for v in victims:
            info(f"  → {v['peer_name']} quitte la coalition")
            async with s.post(f"{BASE_URL}/peers/goodbye", headers=H, json={
                "peer_id": v["peer_id"], "reason": "PANNE_SIMULEE",
            }, ssl=SSL) as r:
                if r.status != 200:
                    err(f"goodbye {v['peer_name']} : HTTP {r.status}")

        snap_t1 = await snapshot(s, H, attack_id)
        info(f"T1 (juste après chaos) : {snap_t1['nb_active']} ACTIVE, "
             f"{snap_t1['volume_active_gbps']} Gbps actifs")

        info("Attente de la reconsidération automatique (reconsiderCoalition)...")
        await asyncio.sleep(3)

        snap_t2 = await snapshot(s, H, attack_id)
        info(f"T2 (après reconsidération) : {snap_t2['nb_active']} ACTIVE, "
             f"{snap_t2['nb_secured']} sécurisées, "
             f"{snap_t2['volume_secured_gbps']} Gbps sécurisés")

        # ------------------------------------------------------------------ #
        step(8, "Vérification — sessions FAILED + nouveaux pairs sollicités")
        async with s.get(f"{BASE_URL}/attacks/{attack_id}", headers=H, ssl=SSL) as r:
            attack_detail = await r.json()
        all_sessions = attack_detail.get("help_sessions", [])

        victim_ids = {v["peer_id"] for v in victims}
        failed_sessions = [
            hs for hs in all_sessions
            if hs.get("helping_peer_id") in victim_ids and hs.get("status") == "FAILED"
        ]
        check_failed = len(failed_sessions) == len(victims)
        (ok if check_failed else err)(
            f"{len(failed_sessions)}/{len(victims)} sessions des pairs tombés marquées FAILED"
        )
        if not check_failed:
            errors.append("sessions_not_failed")

        original_ids = {s_["session_id"] for s_ in sessions}
        new_sessions = [
            hs for hs in all_sessions
            if hs.get("session_id") not in original_ids
            and hs.get("status") in ("REQUESTED", "OFFERED", "ACCEPTED", "ACTIVE")
        ]
        check_new = len(new_sessions) > 0
        (ok if check_new else err)(
            f"{len(new_sessions)} nouvelle(s) session(s) sollicitée(s) automatiquement pour combler le manque"
        )
        if not check_new:
            errors.append("no_auto_resolicitation")

        async with s.get(f"{BASE_URL}/logs/audit?limit=10", headers=H, ssl=SSL) as r:
            audit = await r.json()
        events = audit.get("events", audit) if isinstance(audit, dict) else audit
        reconsider_logs = [
            e for e in (events or [])
            if isinstance(e, dict) and "Reconsidération" in (e.get("description") or "")
        ]
        (ok if reconsider_logs else err)(
            f"{len(reconsider_logs)} entrée(s) d'audit liée(s) à la reconsidération trouvée(s)"
        )
        if not reconsider_logs:
            errors.append("no_audit_trace")

        # ------------------------------------------------------------------ #
        step(9, "Clôture de l'attaque")
        still_active_ids = [
            hs["session_id"] for hs in all_sessions if hs.get("status") == "ACTIVE"
        ]
        async with s.post(f"{BASE_URL}/attack/over", headers=H, json={
            "attack_id": attack_id, "session_ids": still_active_ids,
            "attack_duration_seconds": 180,
        }, ssl=SSL) as r:
            d = await r.json()
            ok(f"Attaque clôturée : sévérité={d.get('severity')}") if r.status in (200, 201) else err(str(d))

    # ---------------------------------------------------------------------- #
    rows = [
        {"label": "T0\navant chaos", **snap_t0},
        {"label": "T1\njuste après", **snap_t1},
        {"label": "T2\naprès reconsid.", **snap_t2},
    ]
    fieldnames = ["label", "nb_active", "nb_secured", "volume_active_gbps", "volume_secured_gbps"]
    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"\n  [OK] CSV → {CSV_PATH}")
    generate_png(rows)

    print("\n" + "=" * 60)
    if errors:
        print(f"{RED}ÉCHECS ({len(errors)}) : {', '.join(errors)}{RESET}")
        return 1
    print(f"{GREEN}TEST DE RÉSILIENCE RÉUSSI — la coalition s'est reconfigurée seule.{RESET}\n")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
