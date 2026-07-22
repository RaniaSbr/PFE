"""
ShieldNet — Test du heartbeat événementiel
=============================================
Valide le nouveau modèle d'annonce (utils/heartbeatSender.js) : aucun
minuteur périodique, un signal n'est envoyé que sur 3 événements précis.

Utilise 2 VRAIS conteneurs Docker (node-university et node-pme) — pas de
pairs virtuels, puisque announceToCoalition() exclut explicitement les
pairs simulés (sim-%, *.shieldnet.local) de la diffusion.

  1. Setup       — reset + init des 2 nœuds, enregistrement croisé
  2. Adhésion    — redémarrage du conteneur pme → announceJoin() (délai 10s)
                   → vérifier qu'university reçoit bien un heartbeat
  3. Silence     — 20s sans aucune action → vérifier qu'AUCUN heartbeat
                   supplémentaire n'arrive (pas de minuteur périodique)
  4. Mise à jour — POST /simulation/node/init sur pme → announceUpdate()
                   → vérifier qu'university reçoit un heartbeat immédiat
  5. Réception déclenche reconsidération — attaque en cours + heartbeat
                   reçu → vérifier la trace d'audit "Reconsidération"
  6. Départ      — POST /peers/goodbye → statut INACTIVE + reconsidération

ATTENTION : ce script redémarre le conteneur shieldnet-pme (docker compose
restart) pour déclencher une vraie annonce d'adhésion au démarrage.

Usage : python tests/heartbeat_test.py
"""

import asyncio
import aiohttp
import subprocess
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

BASE_UNI = "https://localhost:3001/api/v1"
BASE_PME = "https://localhost:3002/api/v1"
INTERNAL_UNI_URL = "https://node-university:8443/api/v1"
INTERNAL_PME_URL = "https://node-pme:8443/api/v1"
SECRET = "shieldnet-secret-key-2025"
SSL = False

GREEN, RED, YELLOW, CYAN, RESET = "\033[92m", "\033[91m", "\033[93m", "\033[96m", "\033[0m"


def ok(msg):   print(f"  {GREEN}[OK]{RESET}  {msg}")
def err(msg):  print(f"  {RED}[ERR]{RESET} {msg}")
def info(msg): print(f"  {YELLOW}---{RESET}  {msg}")
def step(n, msg): print(f"\n{CYAN}ÉTAPE {n:02d}{RESET} — {msg}")


async def get_token(session, base, node_id):
    async with session.post(f"{base}/auth/token", json={"node_id": node_id, "node_secret": SECRET}, ssl=SSL) as r:
        d = await r.json()
        token = d.get("token")
        if not token:
            raise RuntimeError(f"Token non obtenu ({node_id}) : {d}")
        return token


def H(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


async def get_peer_last_heartbeat(session, base, headers, peer_id):
    async with session.get(f"{base}/peers", headers=headers, ssl=SSL) as r:
        peers = await r.json()
    for p in peers:
        if p.get("peer_id") == peer_id:
            return p.get("last_heartbeat"), p.get("status")
    return None, None


def restart_pme():
    subprocess.run(
        ["docker", "compose", "restart", "node-pme"],
        cwd=r"C:\Users\21355\Downloads\rania\Mon PFE",
        capture_output=True, text=True, timeout=60,
    )


async def run():
    errors = []
    connector = aiohttp.TCPConnector(ssl=False)
    async with aiohttp.ClientSession(connector=connector) as s:

        # ------------------------------------------------------------------ #
        step(1, "Setup — reset + init des 2 nœuds réels + enregistrement croisé")
        token_uni = await get_token(s, BASE_UNI, "node-university")
        token_pme = await get_token(s, BASE_PME, "node-pme")

        for base, tok in ((BASE_UNI, token_uni), (BASE_PME, token_pme)):
            async with s.post(f"{base}/simulation/reset", headers=H(tok), ssl=SSL) as r:
                if r.status not in (200, 201, 204):
                    err(f"reset {base} : HTTP {r.status}"); errors.append("reset")

        token_uni = await get_token(s, BASE_UNI, "node-university")
        token_pme = await get_token(s, BASE_PME, "node-pme")

        async with s.post(f"{BASE_UNI}/simulation/node/init", headers=H(token_uni), json={
            "node_name": "ESI Alger", "organization_name": "ESI Alger",
            "organization_type": "UNIVERSITY", "country_code": "DZ",
            "api_endpoint_url": INTERNAL_UNI_URL, "public_key": "LOCAL_KEY_ESI",
            "max_scrubbing_capacity_gbps": 2.0, "current_load_percent": 30,
        }, ssl=SSL) as r:
            d = await r.json()
            uni_node_id = d.get("node_id")
            ok(f"university initialisé — node_id={uni_node_id[:8]}...") if r.status in (200, 201) else err(str(d))

        async with s.post(f"{BASE_PME}/simulation/node/init", headers=H(token_pme), json={
            "node_name": "PME Tech", "organization_name": "PME Tech SARL",
            "organization_type": "PME", "country_code": "DZ",
            "api_endpoint_url": INTERNAL_PME_URL, "public_key": "LOCAL_KEY_PME",
            "max_scrubbing_capacity_gbps": 0.5, "current_load_percent": 20,
        }, ssl=SSL) as r:
            d = await r.json()
            pme_node_id = d.get("node_id")
            ok(f"pme initialisé — node_id={pme_node_id[:8]}...") if r.status in (200, 201) else err(str(d))

        if not uni_node_id or not pme_node_id:
            err("Initialisation incomplète — test interrompu"); return ["init_failed"]

        # Enregistrement croisé : chaque nœud connaît l'autre, avec le
        # node_id RÉEL de l'autre comme peer_id (clé de correspondance pour
        # le heartbeat reçu — cf. routes/discovery.js Peer.findByPk(peer_id)).
        async with s.post(f"{BASE_UNI}/peers/register", headers=H(token_uni), json={
            "peer_id": pme_node_id, "peer_name": "node-pme",
            "organization_name": "PME Tech SARL", "organization_type": "PME",
            "country_code": "DZ", "api_endpoint_url": INTERNAL_PME_URL,
            "public_key": "LOCAL_KEY_PME", "max_scrubbing_capacity_gbps": 0.5,
            "declared_available_gbps": 0.4,
        }, ssl=SSL) as r:
            ok("pme enregistré comme pair d'university") if r.status in (200, 201) else err(str(await r.json()))

        async with s.post(f"{BASE_PME}/peers/register", headers=H(token_pme), json={
            "peer_id": uni_node_id, "peer_name": "node-university",
            "organization_name": "ESI Alger", "organization_type": "UNIVERSITY",
            "country_code": "DZ", "api_endpoint_url": INTERNAL_UNI_URL,
            "public_key": "LOCAL_KEY_ESI", "max_scrubbing_capacity_gbps": 2.0,
            "declared_available_gbps": 1.4,
        }, ssl=SSL) as r:
            ok("university enregistré comme pair de pme") if r.status in (200, 201) else err(str(await r.json()))

        token_uni = await get_token(s, BASE_UNI, "node-university")

        # Pairs virtuels supplémentaires sur university — sans eux,
        # reconsiderCoalition() n'aurait aucun candidat de remplacement à
        # solliciter quand pme quittera la coalition à l'étape 6.
        async with s.post(f"{BASE_UNI}/simulation/seed-peers", headers=H(token_uni), ssl=SSL,
                           timeout=aiohttp.ClientTimeout(total=60)) as r:
            ok("pairs virtuels ajoutés (pool de remplacement)") if r.status in (200, 201) else err(str(await r.json()))
        token_uni = await get_token(s, BASE_UNI, "node-university")

        # ------------------------------------------------------------------ #
        step(2, "Adhésion — redémarrage de pme → announceJoin() (délai 10s)")
        ts0, _ = await get_peer_last_heartbeat(s, BASE_UNI, H(token_uni), pme_node_id)
        info(f"last_heartbeat avant redémarrage : {ts0}")
        info("Redémarrage du conteneur node-pme...")
        restart_pme()
        info("Attente de l'annonce initiale (~13s)...")
        await asyncio.sleep(13)

        ts1, status1 = await get_peer_last_heartbeat(s, BASE_UNI, H(token_uni), pme_node_id)
        check_join = ts1 is not None and ts1 != ts0
        (ok if check_join else err)(f"heartbeat reçu après adhésion : last_heartbeat={ts1}  status={status1}")
        if not check_join:
            errors.append("no_join_heartbeat")

        # ------------------------------------------------------------------ #
        step(3, "Silence — 20s sans action → aucun heartbeat périodique attendu")
        await asyncio.sleep(20)
        ts2, _ = await get_peer_last_heartbeat(s, BASE_UNI, H(token_uni), pme_node_id)
        check_silence = ts2 == ts1
        (ok if check_silence else err)(
            f"last_heartbeat inchangé pendant le silence : {ts2}" if check_silence
            else f"ÉCHEC — last_heartbeat a changé sans événement déclencheur : {ts1} -> {ts2}"
        )
        if not check_silence:
            errors.append("unexpected_periodic_heartbeat")

        # ------------------------------------------------------------------ #
        step(4, "Mise à jour — re-POST /simulation/node/init sur pme → announceUpdate()")
        token_pme = await get_token(s, BASE_PME, "node-pme")
        async with s.post(f"{BASE_PME}/simulation/node/init", headers=H(token_pme), json={
            "node_name": "PME Tech", "organization_name": "PME Tech SARL",
            "organization_type": "PME", "country_code": "DZ",
            "api_endpoint_url": INTERNAL_PME_URL, "public_key": "LOCAL_KEY_PME",
            "max_scrubbing_capacity_gbps": 0.5, "current_load_percent": 55,
        }, ssl=SSL) as r:
            if r.status not in (200, 201):
                err(f"update pme : HTTP {r.status}"); errors.append("update_pme")

        await asyncio.sleep(3)
        ts3, _ = await get_peer_last_heartbeat(s, BASE_UNI, H(token_uni), pme_node_id)
        check_update = ts3 is not None and ts3 != ts2
        (ok if check_update else err)(f"heartbeat reçu immédiatement après mise à jour : last_heartbeat={ts3}")
        if not check_update:
            errors.append("no_update_heartbeat")

        # ------------------------------------------------------------------ #
        step(5, "Réception pendant une attaque → reconsidération automatique")
        token_uni = await get_token(s, BASE_UNI, "node-university")
        async with s.post(f"{BASE_UNI}/alert", headers=H(token_uni), json={
            "peak_volume_gbps": 5, "overflow_volume_gbps": 3,
            "local_capacity_at_detection": 1.4, "target_ip_range": "10.0.1.0/24",
            "target_service": "HTTP", "target_protocol": "TCP",
        }, ssl=SSL) as r:
            d = await r.json()
            attack_id = d.get("attack_id")
            ok(f"Attaque créée : {attack_id[:8]}...") if r.status in (200, 201) else err(str(d))

        async with s.post(f"{BASE_UNI}/heartbeat", headers=H(token_uni), json={
            "peer_id": pme_node_id, "reported_status": "ACTIVE",
            "reported_load_pct": 60, "reported_available_gbps": 0.3,
            "round_trip_time_ms": 14,
        }, ssl=SSL) as r:
            ok("Heartbeat direct envoyé") if r.status in (200, 201) else err(str(await r.json()))

        await asyncio.sleep(1)
        async with s.get(f"{BASE_UNI}/logs/audit?limit=10", headers=H(token_uni), ssl=SSL) as r:
            audit = await r.json()
        events = audit.get("events", audit) if isinstance(audit, dict) else audit
        reconsider_logs = [
            e for e in (events or [])
            if isinstance(e, dict) and "mise à jour de capacité" in (e.get("description") or "")
        ]
        check_reconsider = len(reconsider_logs) > 0
        (ok if check_reconsider else err)(
            f"{len(reconsider_logs)} trace(s) d'audit de reconsidération (mise à jour de capacité)"
        )
        if not check_reconsider:
            errors.append("no_reconsider_on_heartbeat")

        # ------------------------------------------------------------------ #
        step(6, "Départ — POST /peers/goodbye → INACTIVE + reconsidération")
        async with s.post(f"{BASE_UNI}/peers/goodbye", headers=H(token_uni), json={
            "peer_id": pme_node_id, "reason": "TEST_DEPART",
        }, ssl=SSL) as r:
            d = await r.json()
            ok(f"goodbye envoyé : status={d.get('status')}") if r.status == 200 else err(str(d))

        await asyncio.sleep(1)
        _, status_after = await get_peer_last_heartbeat(s, BASE_UNI, H(token_uni), pme_node_id)
        check_leave = status_after == "INACTIVE"
        (ok if check_leave else err)(f"statut de pme après départ : {status_after}")
        if not check_leave:
            errors.append("goodbye_status_not_inactive")

        async with s.get(f"{BASE_UNI}/logs/audit?limit=10", headers=H(token_uni), ssl=SSL) as r:
            audit = await r.json()
        events = audit.get("events", audit) if isinstance(audit, dict) else audit
        depart_logs = [
            e for e in (events or [])
            if isinstance(e, dict) and "départ de la coalition" in (e.get("description") or "")
        ]
        check_depart_log = len(depart_logs) > 0
        (ok if check_depart_log else err)(f"{len(depart_logs)} trace(s) d'audit de reconsidération (départ)")
        if not check_depart_log:
            errors.append("no_reconsider_on_goodbye")

        # ------------------------------------------------------------------ #
        if attack_id:
            await s.post(f"{BASE_UNI}/attack/over", headers=H(token_uni), json={
                "attack_id": attack_id, "session_ids": [], "attack_duration_seconds": 60,
            }, ssl=SSL)

    # ---------------------------------------------------------------------- #
    print("\n" + "=" * 60)
    if errors:
        print(f"{RED}ÉCHECS ({len(errors)}) : {', '.join(errors)}{RESET}")
        return 1
    print(f"{GREEN}TEST HEARTBEAT ÉVÉNEMENTIEL RÉUSSI — pas de minuteur, signal sur événement uniquement.{RESET}\n")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
