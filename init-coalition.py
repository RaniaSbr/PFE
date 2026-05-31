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
    {"name": "node-university", "port": 3001, "cert": "university", "org": "Universite d Alger",  "type": "UNIVERSITY", "capacity": 10.0},
    {"name": "node-pme",        "port": 3002, "cert": "pme",        "org": "PME Algeroise",       "type": "PME",        "capacity":  5.0},
    {"name": "node-isp",        "port": 3003, "cert": "isp",        "org": "Algerie Telecom ISP", "type": "ISP",        "capacity": 20.0},
    {"name": "node-datacenter", "port": 3004, "cert": "datacenter", "org": "Datacenter Oran",     "type": "DATACENTER", "capacity": 15.0},
]
SECRET = "shieldnet-secret-key-2025"

def load_cert(cert_name):
    path = BASE / "certs" / cert_name / "node.crt"
    return path.read_text() if path.exists() else f"FAKE_KEY_{cert_name}"

async def get_node_id(session, node):
    """Recupere le vrai node_id (UUID) depuis GET / du noeud."""
    try:
        async with session.get(
            f"https://localhost:{node['port']}/",
            ssl=SSL_CTX, timeout=aiohttp.ClientTimeout(total=4)
        ) as r:
            d = await r.json()
            return d.get("node_id", "")
    except Exception:
        return ""

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
                "country_code": "DZ",
                "api_endpoint_url": f"https://localhost:{node['port']}/api/v1",
                "public_key": pub_key,
                "max_scrubbing_capacity_gbps": node["capacity"],
                "current_load_percent": 20,
            },
            ssl=SSL_CTX, timeout=aiohttp.ClientTimeout(total=5)
        ) as r:
            d = await r.json()
            uid = d.get("node_id", "")
            print(f"  [OK] Init {node['name']} -> HTTP {r.status} (uuid: {uid[:8]}...)")
            return uid
    except Exception as e:
        print(f"  [WARN] Init {node['name']} : {e}")
        return ""

async def register_peer(session, target, peer, pub_key, peer_node_id=""):
    try:
        body = {
            "peer_name": peer["name"],
            "organization_name": peer["org"],
            "organization_type": peer["type"],
            "country_code": "DZ",
            "api_endpoint_url": f"https://node-{peer['cert']}:8443/api/v1",
            "public_key": pub_key,
            "max_scrubbing_capacity_gbps": peer["capacity"],
            "declared_available_gbps": peer["capacity"] * 0.8,
        }
        # Passer le vrai node_id comme peer_id pour que le JWT soit reconnu
        if peer_node_id:
            body["peer_id"] = peer_node_id

        async with session.post(
            f"https://localhost:{target['port']}/api/v1/peers/register",
            json=body,
            ssl=SSL_CTX, timeout=aiohttp.ClientTimeout(total=5)
        ) as r:
            if r.status in (200, 201):
                print(f"  [OK] {peer['name']} -> {target['name']} (peer_id: {peer_node_id[:8]}...)")
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

        # 1. Verifier que les noeuds repondent + recuperer leurs vrais node_id
        print("--- Verification des noeuds ---")
        node_ids = {}
        for n in NODES:
            try:
                async with session.get(
                    f"https://localhost:{n['port']}/",
                    ssl=SSL_CTX, timeout=aiohttp.ClientTimeout(total=4)
                ) as r:
                    d = await r.json()
                    node_ids[n["name"]] = d.get("node_id", "")
                    print(f"  [OK] {n['name']} repond (node_id: {node_ids[n['name']][:8]}...)")
            except Exception as e:
                print(f"  [ERREUR] {n['name']} inaccessible : {e}")
                print("  -> Verifie que Docker tourne : docker compose up -d")
                return

        # 2. Initialiser les noeuds locaux + recuperer les vrais UUID
        print("\n--- Initialisation locale de chaque noeud ---")
        for n in NODES:
            uid = await init_node(session, n, certs[n["name"]])
            if uid:
                node_ids[n["name"]] = uid

        # 3. Enregistrement croise avec les vrais peer_id
        print("\n--- Enregistrement croise des pairs ---")
        for target in NODES:
            for peer in NODES:
                if peer["name"] == target["name"]:
                    continue
                await register_peer(
                    session, target, peer,
                    certs[peer["name"]],
                    peer_node_id=node_ids.get(peer["name"], "")
                )

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
    print("Ouvre https://localhost:3001/dashboard\n")

if __name__ == "__main__":
    asyncio.run(main())
