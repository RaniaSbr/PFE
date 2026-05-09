"""
ShieldNet — Test de scalabilité (20 → 100 nœuds)

Simule N nœuds avec des caractéristiques aléatoires et mesure :
  - Temps d'enregistrement (POST /peers/register)
  - Temps de heartbeat    (POST /heartbeat)
  - Temps de sélection WSM (POST /trust/select-peers)

Usage :
  pip install -r tests/requirements.txt
  python tests/scalability_test.py

  # Changer l'URL si le nœud n'est pas sur localhost:3001 :
  python tests/scalability_test.py --url http://localhost:3001 --steps 20 40 60 80 100
"""

import asyncio
import aiohttp
import ssl
import uuid
import random
import time
import argparse
import sys
import pandas as pd
import matplotlib
matplotlib.use("Agg")          # pas d'interface graphique requise
import matplotlib.pyplot as plt

# Désactive la vérification SSL (certificats auto-signés en dev)
SSL_CTX = False

# ── Constantes ────────────────────────────────────────────────────────────────

ORGANIZATION_TYPES = ["UNIVERSITY", "ISP", "PME", "DATACENTER"]
TIERS              = ["T1", "T2", "T3"]
COUNTRY_CODES      = ["TN", "FR", "DZ", "MA", "DE"]

AUTH_NODE_ID = "node-university"
AUTH_SECRET  = "shieldnet-secret-key-2025"

# ── Fonctions d'appel API ─────────────────────────────────────────────────────

async def get_auth_token(session: aiohttp.ClientSession, base_url: str) -> str:
    """Obtient un JWT auprès du nœud cible."""
    try:
        async with session.post(
            f"{base_url}/api/v1/auth/token",
            json={"node_id": AUTH_NODE_ID, "node_secret": AUTH_SECRET},
            timeout=aiohttp.ClientTimeout(total=10),
            ssl=SSL_CTX,
        ) as r:
            data = await r.json()
            return data.get("token", "")
    except Exception:
        return ""


async def register_node(session: aiohttp.ClientSession, base_url: str, index: int):
    """Enregistre un nœud avec des caractéristiques aléatoires."""
    peer_id  = str(uuid.uuid4())
    capacity = round(random.uniform(0.5, 10.0), 2)   # Gbps

    payload = {
        "peer_id":           peer_id,
        "peer_name":         f"vnode-{index:03d}",
        "organization_name": f"Org-{index}",
        "organization_type": random.choice(ORGANIZATION_TYPES),
        "tier":              random.choice(TIERS),
        "country_code":      random.choice(COUNTRY_CODES),
        "api_endpoint_url":  f"https://vnode-{index:03d}:8443",
        "public_key":        f"FAKE_TEST_KEY_{peer_id}",
        "max_scrubbing_capacity_gbps": capacity,
    }

    t0 = time.perf_counter()
    try:
        async with session.post(f"{base_url}/api/v1/peers/register",
                                json=payload, timeout=aiohttp.ClientTimeout(total=10),
                                ssl=SSL_CTX) as r:
            latency_ms = (time.perf_counter() - t0) * 1000
            return {
                "peer_id":    peer_id,
                "capacity":   capacity,
                "latency_ms": latency_ms,
                "status":     r.status,
                "ok":         r.status in (200, 201),
            }
    except Exception:
        return {"peer_id": peer_id, "capacity": 0,
                "latency_ms": 9999, "status": 0, "ok": False}


async def send_heartbeat(session: aiohttp.ClientSession, base_url: str,
                         peer_id: str, token: str):
    """Envoie un heartbeat avec une charge et une latence aléatoires."""
    load     = round(random.uniform(10, 90), 1)
    capacity = round(random.uniform(0.1, 5.0), 2)

    payload = {
        "peer_id":                 peer_id,
        "reported_status":         "ACTIVE",
        "reported_load_pct":       load,
        "reported_available_gbps": round(capacity * (1 - load / 100), 3),
        "round_trip_time_ms":      random.randint(5, 200),
    }
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    t0 = time.perf_counter()
    try:
        async with session.post(f"{base_url}/api/v1/heartbeat",
                                json=payload, headers=headers,
                                timeout=aiohttp.ClientTimeout(total=10),
                                ssl=SSL_CTX) as r:
            return {
                "latency_ms": (time.perf_counter() - t0) * 1000,
                "status":     r.status,
                "ok":         r.status in (200, 201),
            }
    except Exception:
        return {"latency_ms": 9999, "status": 0, "ok": False}


async def wsm_select_peers(session: aiohttp.ClientSession, base_url: str,
                           token: str):
    """Lance la sélection WSM sur tous les nœuds enregistrés."""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    t0 = time.perf_counter()
    try:
        async with session.post(f"{base_url}/api/v1/trust/select-peers",
                                json={}, headers=headers,
                                timeout=aiohttp.ClientTimeout(total=15),
                                ssl=SSL_CTX) as r:
            data = await r.json()
            total = (data.get("total_peers")
                     or len(data.get("ranked_peers", []))
                     or data.get("count", 0))
            return {
                "latency_ms":   (time.perf_counter() - t0) * 1000,
                "status":       r.status,
                "total_peers":  total,
                "ok":           r.status == 200,
            }
    except Exception:
        return {"latency_ms": 9999, "status": 0, "total_peers": 0, "ok": False}


async def _delete_one(session: aiohttp.ClientSession, base_url: str,
                      pid: str, token: str):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        async with session.delete(
            f"{base_url}/api/v1/peers/{pid}",
            headers=headers,
            timeout=aiohttp.ClientTimeout(total=5),
            ssl=SSL_CTX,
        ):
            pass
    except Exception:
        pass


async def cleanup_peers(session: aiohttp.ClientSession, base_url: str,
                        peer_ids: list, token: str):
    """Supprime tous les nœuds de test après chaque palier."""
    await asyncio.gather(
        *[_delete_one(session, base_url, pid, token) for pid in peer_ids]
    )


# ── Scénario par palier ───────────────────────────────────────────────────────

async def run_step(nb_nodes: int, base_url: str) -> dict:
    print(f"  [{nb_nodes:>3d} nœuds] enregistrement...", end="", flush=True)

    async with aiohttp.ClientSession() as session:

        # ── Authentification ──────────────────────────────────────────────────
        token = await get_auth_token(session, base_url)

        # ── Phase 1 : enregistrement en parallèle ────────────────────────────
        reg_tasks = [register_node(session, base_url, i) for i in range(nb_nodes)]
        reg_results = await asyncio.gather(*reg_tasks)

        peer_ids      = [r["peer_id"]    for r in reg_results if r["ok"]]
        reg_latencies = [r["latency_ms"] for r in reg_results]
        reg_ok        = sum(1 for r in reg_results if r["ok"])

        print(f" heartbeat...", end="", flush=True)

        # ── Phase 2 : heartbeats en parallèle ────────────────────────────────
        hb_tasks   = [send_heartbeat(session, base_url, pid, token)
                      for pid in peer_ids]
        hb_results = await asyncio.gather(*hb_tasks)

        hb_latencies = [r["latency_ms"] for r in hb_results]
        hb_ok        = sum(1 for r in hb_results if r["ok"])

        print(f" WSM...", end="", flush=True)

        # ── Phase 3 : sélection WSM avec N candidats ──────────────────────────
        wsm = await wsm_select_peers(session, base_url, token)

        print(f" nettoyage...", end="", flush=True)

        # ── Nettoyage : token frais (le palier peut dépasser 60 s) ───────────
        fresh_token = await get_auth_token(session, base_url) or token
        await cleanup_peers(session, base_url, peer_ids, fresh_token)

    print(f" OK")

    return {
        "noeuds":              nb_nodes,
        "register_ok":         reg_ok,
        "register_moy_ms":     round(sum(reg_latencies) / max(len(reg_latencies), 1), 2),
        "register_max_ms":     round(max(reg_latencies) if reg_latencies else 0, 2),
        "heartbeat_ok":        hb_ok,
        "heartbeat_moy_ms":    round(sum(hb_latencies) / max(len(hb_latencies), 1), 2),
        "heartbeat_max_ms":    round(max(hb_latencies) if hb_latencies else 0, 2),
        "wsm_ms":              round(wsm["latency_ms"], 2),
        "wsm_peers_trouves":   wsm["total_peers"],
    }


# ── Programme principal ───────────────────────────────────────────────────────

async def main(base_url: str, steps: list):
    print(f"\nShieldNet — Test de scalabilité")
    print(f"URL cible : {base_url}")
    print(f"Paliers   : {steps}\n")

    # Vérifier que l'API est accessible
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{base_url}/api/v1/simulation/ping",
                             timeout=aiohttp.ClientTimeout(total=5),
                             ssl=SSL_CTX) as r:
                print(f"  API accessible (HTTP {r.status}) ✓\n")
    except Exception as e:
        print(f"  ERREUR : impossible de joindre {base_url}")
        print(f"  Détail : {e}")
        print(f"  Vérifiez que ShieldNet tourne (docker compose up)\n")
        sys.exit(1)

    # Nettoyage initial — vider les pairs résiduels des runs précédents
    try:
        async with aiohttp.ClientSession() as s:
            init_token = await get_auth_token(s, base_url)
            headers = {"Authorization": f"Bearer {init_token}"} if init_token else {}
            async with s.post(f"{base_url}/api/v1/simulation/reset",
                              headers=headers,
                              timeout=aiohttp.ClientTimeout(total=15),
                              ssl=SSL_CTX) as r:
                print(f"  Reset base de données (HTTP {r.status}) ✓\n")
    except Exception as e:
        print(f"  [WARN] Reset échoué : {e}\n")

    summary = []
    for n in steps:
        result = await run_step(n, base_url)
        summary.append(result)

    # ── Affichage du tableau ──────────────────────────────────────────────────
    df = pd.DataFrame(summary)
    print("\n" + "─" * 80)
    print("RÉSULTATS")
    print("─" * 80)
    print(df[[
        "noeuds",
        "register_moy_ms", "register_max_ms",
        "heartbeat_moy_ms", "heartbeat_max_ms",
        "wsm_ms", "wsm_peers_trouves"
    ]].to_string(index=False))
    print("─" * 80)

    # ── Graphiques ────────────────────────────────────────────────────────────
    fig, axes = plt.subplots(1, 3, figsize=(15, 5))
    fig.suptitle("ShieldNet — Scalabilité (20 → 100 nœuds)", fontsize=13, fontweight="bold")

    axes[0].plot(df["noeuds"], df["register_moy_ms"],  "o-",  color="steelblue",  label="Moyenne")
    axes[0].plot(df["noeuds"], df["register_max_ms"],  "o--", color="lightblue",  label="Maximum")
    axes[0].set_title("Enregistrement — latence (ms)")
    axes[0].set_xlabel("Nombre de nœuds")
    axes[0].set_ylabel("ms")
    axes[0].legend()
    axes[0].grid(True, alpha=0.4)

    axes[1].plot(df["noeuds"], df["heartbeat_moy_ms"], "s-",  color="seagreen",   label="Moyenne")
    axes[1].plot(df["noeuds"], df["heartbeat_max_ms"], "s--", color="lightgreen", label="Maximum")
    axes[1].set_title("Heartbeat — latence (ms)")
    axes[1].set_xlabel("Nombre de nœuds")
    axes[1].set_ylabel("ms")
    axes[1].legend()
    axes[1].grid(True, alpha=0.4)

    axes[2].plot(df["noeuds"], df["wsm_ms"],           "^-",  color="tomato")
    axes[2].set_title("Sélection WSM — temps de calcul (ms)")
    axes[2].set_xlabel("Nombre de nœuds")
    axes[2].set_ylabel("ms")
    axes[2].grid(True, alpha=0.4)

    plt.tight_layout()
    output_path = "tests/shieldnet_scalability.png"
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    print(f"\nGraphique sauvegardé : {output_path}")

    # Sauvegarder les données CSV
    csv_path = "tests/shieldnet_scalability.csv"
    df.to_csv(csv_path, index=False)
    print(f"Données CSV          : {csv_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ShieldNet scalability test")
    parser.add_argument("--url",   default="https://localhost:3001",
                        help="URL de base du nœud ShieldNet (défaut: https://localhost:3001)")
    parser.add_argument("--steps", nargs="+", type=int,
                        default=[20, 40, 60, 80, 100],
                        help="Paliers de nœuds à tester (défaut: 20 40 60 80 100)")
    args = parser.parse_args()

    asyncio.run(main(args.url, args.steps))
