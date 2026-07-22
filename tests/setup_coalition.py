"""
ShieldNet — Mise en place de la coalition à 4 vrais nœuds
=============================================================
Réinitialise les 4 nœuds Docker, les initialise, puis les enregistre
les uns auprès des autres (maillage complet, 4x3 = 12 enregistrements).

À relancer chaque fois que /simulation/reset a été appelé sur un ou
plusieurs nœuds — sinon le mécanisme d'auto-enregistrement (déclenché
quand un pair inconnu contacte un nœud pour la première fois) peut créer
des entrées avec une mauvaise adresse de rappel (cf. bug identifié dans
routes/coalition.js, POST /help/offer).

Prérequis : docker compose up -d (les 4 nœuds doivent répondre).

Usage : python tests/setup_coalition.py
"""

import asyncio
import aiohttp
import sys

if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

SECRET = "shieldnet-secret-key-2025"
SSL = False

NODES = {
    "university": {
        "base": "https://localhost:3001/api/v1", "node_id": "node-university",
        "init": {
            "node_name": "ESI Alger", "organization_name": "ESI Alger",
            "organization_type": "UNIVERSITY", "country_code": "DZ",
            "api_endpoint_url": "https://node-university:8443/api/v1",
            "public_key": "LOCAL_KEY_ESI", "max_scrubbing_capacity_gbps": 10,
            "current_load_percent": 30,
        },
    },
    "pme": {
        "base": "https://localhost:3002/api/v1", "node_id": "node-pme",
        "init": {
            "node_name": "PME Tech", "organization_name": "PME Tech SARL",
            "organization_type": "PME", "country_code": "DZ",
            "api_endpoint_url": "https://node-pme:8443/api/v1",
            "public_key": "LOCAL_KEY_PME", "max_scrubbing_capacity_gbps": 5,
            "current_load_percent": 20,
        },
    },
    "isp": {
        "base": "https://localhost:3003/api/v1", "node_id": "node-isp",
        "init": {
            "node_name": "Algerie Telecom", "organization_name": "Algerie Telecom",
            "organization_type": "ISP", "country_code": "DZ",
            "api_endpoint_url": "https://node-isp:8443/api/v1",
            "public_key": "LOCAL_KEY_ISP", "max_scrubbing_capacity_gbps": 20,
            "current_load_percent": 25,
        },
    },
    "datacenter": {
        "base": "https://localhost:3004/api/v1", "node_id": "node-datacenter",
        "init": {
            "node_name": "DataCenter Oran", "organization_name": "DataCenter Oran",
            "organization_type": "DATACENTER", "country_code": "DZ",
            "api_endpoint_url": "https://node-datacenter:8443/api/v1",
            "public_key": "LOCAL_KEY_DC", "max_scrubbing_capacity_gbps": 15,
            "current_load_percent": 30,
        },
    },
}


async def get_token(s, base, node_id):
    async with s.post(f"{base}/auth/token", json={"node_id": node_id, "node_secret": SECRET}, ssl=SSL) as r:
        d = await r.json()
        return d.get("token")


async def main():
    connector = aiohttp.TCPConnector(ssl=False)
    async with aiohttp.ClientSession(connector=connector) as s:

        print("=== 1. Reset des 4 nœuds ===")
        for name, cfg in NODES.items():
            tok = await get_token(s, cfg["base"], cfg["node_id"])
            H = {"Authorization": f"Bearer {tok}"}
            async with s.post(f"{cfg['base']}/simulation/reset", headers=H, ssl=SSL) as r:
                print(f"  {name}: HTTP {r.status}")

        print("\n=== 2. Initialisation des 4 nœuds ===")
        node_ids = {}
        for name, cfg in NODES.items():
            tok = await get_token(s, cfg["base"], cfg["node_id"])
            H = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
            async with s.post(f"{cfg['base']}/simulation/node/init", headers=H, json=cfg["init"], ssl=SSL) as r:
                d = await r.json()
                node_ids[name] = d.get("node_id")
                print(f"  {name}: HTTP {r.status} -> node_id={node_ids[name]}")

        print("\n=== 3. Enregistrement croisé (maillage complet) ===")
        for name, cfg in NODES.items():
            tok = await get_token(s, cfg["base"], cfg["node_id"])
            H = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
            for other_name, other_cfg in NODES.items():
                if other_name == name:
                    continue
                payload = {
                    "peer_id": node_ids[other_name],
                    "peer_name": other_cfg["node_id"],
                    "organization_name": other_cfg["init"]["organization_name"],
                    "organization_type": other_cfg["init"]["organization_type"],
                    "country_code": "DZ",
                    "api_endpoint_url": other_cfg["init"]["api_endpoint_url"],
                    "public_key": other_cfg["init"]["public_key"],
                    "max_scrubbing_capacity_gbps": other_cfg["init"]["max_scrubbing_capacity_gbps"],
                    "declared_available_gbps": round(other_cfg["init"]["max_scrubbing_capacity_gbps"] * 0.8, 2),
                }
                async with s.post(f"{cfg['base']}/peers/register", headers=H, json=payload, ssl=SSL) as r:
                    status_icon = "OK" if r.status in (200, 201) else "ERR"
                    print(f"  {name} -> connaît {other_name}: {status_icon} (HTTP {r.status})")

        print("\n=== Vérification finale ===")
        all_ok = True
        for name, cfg in NODES.items():
            tok = await get_token(s, cfg["base"], cfg["node_id"])
            H = {"Authorization": f"Bearer {tok}"}
            async with s.get(f"{cfg['base']}/peers", headers=H, ssl=SSL) as r:
                peers = await r.json()
            if len(peers) != 3:
                all_ok = False
            print(f"  {name}: {len(peers)} pair(s) connu(s) -> " +
                  ", ".join(f"{p.get('peer_name')}" for p in peers))

        print("\n" + ("Coalition prête pour la démo." if all_ok else
                       "ATTENTION : un nœud n'a pas exactement 3 pairs, vérifie ci-dessus."))


if __name__ == "__main__":
    asyncio.run(main())
