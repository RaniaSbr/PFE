"""
init-coalition.py
Initialise la coalition ShieldNet : enregistrement croise des 4 noeuds.
Usage : python init-coalition.py
"""
import asyncio, aiohttp, ssl, json
from pathlib import Path

BASE = Path(__file__).parent
SSL_CTX = False  # ignore certs auto-signes (comme le test de scalabilite)

NODES = [
    {"name": "node-university", "port": 3001, "cert": "university", "org": "Universite d Alger",  "type": "UNIVERSITY", "tier": "T2", "capacity": 10.0},
    {"name": "node-pme",        "port": 3002, "cert": "pme",        "org": "PME Algeroise",       "type": "PME",        "tier": "T3", "capacity":  5.0},
    {"name": "node-isp",        "port": 3003, "cert": "isp",        "org": "Algerie Telecom ISP", "type": "ISP",        "tier": "T1", "capacity": 20.0},
    {"name": "node-datacenter", "port": 3004, "cert": "datacenter", "org": "Datacenter Oran",     "type": "DATACENTER", "tier": "T1", "capacity": 15.0},
]
SECRET = "shieldnet-secret-key-2025"

def load_cert(cert_name):
    path = BASE / "certs" / cert_name / "node.crt"
    return path.read_text() if path.exists() else f"FAKE_KEY_{cert_name}"

async def get_token(session, node):
    try:
        async with session.post(
            f"https://localhost:{node['port']}/api/v1/auth/token",
            json={"node_id": node["name"], "node_secret": SECRET},
            ssl=SSL_CTX, timeout=aiohttp.ClientTimeout(total=5)
        ) as r:
            d = await r.json()
            return d.get("token", "")
    except Exception as e:
        print(f"  [WARN] Token {node['name']} : {e}")
        return ""

async def init_node(session, node, pub_key):
    try:
        async with session.post(
            f"https://localhost:{node['port']}/api/v1/simulation/node/init",
            json={
                "node_name": node["name"],
                "organization_name": node["org"],
                "organization_type": node["type"],
                "tier": node["tier"],
                "country_code": "DZ",
                "api_endpoint_url": f"https://localhost:{node['port']}/api/v1",
                "public_key": pub_key,
                "max_scrubbing_capacity_gbps": node["capacity"],
                "current_load_percent": 20,
            },
            ssl=SSL_CTX, timeout=aiohttp.ClientTimeout(total=5)
        ) as r:
            status = r.status
            print(f"  [OK] Init {node['name']} -> HTTP {status}")
    except Exception as e:
        print(f"  [WARN] Init {node['name']} : {e}")

async def register_peer(session, target, peer, pub_key):
    try:
        async with session.post(
            f"https://localhost:{target['port']}/api/v1/peers/register",
            json={
                "peer_name": peer["name"],
                "organization_name": peer["org"],
                "organization_type": peer["type"],
                "tier": peer["tier"],
                "country_code": "DZ",
                "api_endpoint_url": f"https://node-{peer['cert']}:8443/api/v1",
                "public_key": pub_key,
                "max_scrubbing_capacity_gbps": peer["capacity"],
                "declared_available_gbps": peer["capacity"] * 0.8,
            },
            ssl=SSL_CTX, timeout=aiohttp.ClientTimeout(total=5)
        ) as r:
            if r.status in (200, 201):
                print(f"  [OK] {peer['name']} -> {target['name']}")
            elif r.status == 409:
                print(f"  [--] {peer['name']} -> {target['name']} (deja enregistre)")
            else:
                txt = await r.text()
                print(f"  [WARN] {peer['name']} -> {target['name']} : HTTP {r.status} {txt[:60]}")
    except Exception as e:
        print(f"  [WARN] {peer['name']} -> {target['name']} : {e}")

async def main():
    print("\nShieldNet — Initialisation de la coalition")
    print("=" * 50)

    # Charger les certs PEM
    certs = {n["name"]: load_cert(n["cert"]) for n in NODES}
    print("[OK] Certificats PEM charges\n")

    async with aiohttp.ClientSession() as session:

        # 1. Verifier que les noeuds repondent
        print("--- Verification des noeuds ---")
        for n in NODES:
            try:
                async with session.get(
                    f"https://localhost:{n['port']}/",
                    ssl=SSL_CTX, timeout=aiohttp.ClientTimeout(total=4)
                ) as r:
                    d = await r.json()
                    print(f"  [OK] {n['name']} repond (node_id: {d.get('node_id','?')})")
            except Exception as e:
                print(f"  [ERREUR] {n['name']} inaccessible : {e}")
                print("  -> Verifie que Docker tourne : docker compose up -d")
                return

        # 2. Initialiser les noeuds locaux
        print("\n--- Initialisation locale de chaque noeud ---")
        for n in NODES:
            await init_node(session, n, certs[n["name"]])

        # 3. Enregistrement croise
        print("\n--- Enregistrement croise des pairs ---")
        for target in NODES:
            for peer in NODES:
                if peer["name"] == target["name"]:
                    continue
                await register_peer(session, target, peer, certs[peer["name"]])

        # 4. Verification finale
        print("\n--- Verification finale ---")
        for n in NODES:
            token = await get_token(session, n)
            if token:
                try:
                    async with session.get(
                        f"https://localhost:{n['port']}/api/v1/peers",
                        headers={"Authorization": f"Bearer {token}"},
                        ssl=SSL_CTX, timeout=aiohttp.ClientTimeout(total=5)
                    ) as r:
                        peers = await r.json()
                        count = len(peers) if isinstance(peers, list) else "?"
                        print(f"  [OK] {n['name']} : {count} pair(s) enregistre(s)")
                except Exception as e:
                    print(f"  [WARN] {n['name']} : {e}")
            else:
                print(f"  [WARN] {n['name']} : token non obtenu")

    print("\n[SUCCES] Coalition initialisee !")
    print("Ouvre https://localhost:3001/dashboard dans Chrome\n")

if __name__ == "__main__":
    asyncio.run(main())
