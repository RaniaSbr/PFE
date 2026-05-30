"""
seed_trust_demo.py
Injecte 100 pairs virtuels avec des scores de confiance variés dans ShieldNet.
Usage : python tests/seed_trust_demo.py
"""
import asyncio, aiohttp, json

BASE_URL = "https://localhost:3001"
SECRET   = "shieldnet-secret-key-2025"
NODE_ID  = "node-university"
SSL      = False  # ignore les certs auto-signés


async def get_token(session):
    async with session.post(
        f"{BASE_URL}/api/v1/auth/token",
        json={"node_id": NODE_ID, "node_secret": SECRET},
        ssl=SSL,
    ) as r:
        d = await r.json()
        token = d.get("token", "")
        if not token:
            raise RuntimeError(f"Token non obtenu : {d}")
        return token


async def main():
    print("\nShieldNet — Seed 100 pairs de démo")
    print("=" * 50)

    async with aiohttp.ClientSession() as session:
        print("1. Obtention du token JWT...")
        token = await get_token(session)
        print("   [OK]")

        print("2. Injection des 100 pairs via /simulation/seed-peers...")
        async with session.post(
            f"{BASE_URL}/api/v1/simulation/seed-peers",
            headers={"Authorization": f"Bearer {token}"},
            ssl=SSL,
            timeout=aiohttp.ClientTimeout(total=60),
        ) as r:
            if r.status not in (200, 201):
                txt = await r.text()
                print(f"   [ERREUR] HTTP {r.status} : {txt}")
                return
            data = await r.json()

        dist = data.get("distribution", {})
        print(f"   [OK] {data.get('message')}")
        print("\n   Distribution des niveaux de confiance :")
        for level in ["GOLD", "SILVER", "BRONZE", "SUSPECT", "BANNED"]:
            n = dist.get(level, 0)
            bar = "#" * n
            print(f"   {level:<8} {n:>3}  {bar}")

        print("\n3. Aperçu des scores (10 premiers par niveau) :")
        peers = data.get("peers", [])
        shown = {}
        for p in peers:
            lvl = p["level"]
            if shown.get(lvl, 0) >= 3:
                continue
            shown[lvl] = shown.get(lvl, 0) + 1
            score = float(p["score"])
            print(f"   {p['peer']:<12}  {lvl:<8}  score={score:.3f}")

    print("\n[SUCCÈS] Ouvre https://localhost:3001/dashboard et recharge la page.")


if __name__ == "__main__":
    asyncio.run(main())
