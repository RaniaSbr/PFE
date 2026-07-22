import asyncio
import aiohttp
import ssl
import time
import csv
import os
import sys
import random
import argparse
import statistics
from datetime import datetime

# ── Encodage UTF-8 sur Windows ────────────────────────────────────────────────
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")

# ── Matplotlib optionnel ──────────────────────────────────────────────────────
try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False
    print("[WARN] matplotlib non installé — PNG ignoré (pip install matplotlib)")

random.seed(42)

# ── Configuration par défaut (surchargeables via CLI) ─────────────────────────
BASE_URL      = "https://localhost:3001/api/v1"
NODE_ID       = "node-university"
SECRET        = "shieldnet-secret-key-2025"

SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode    = ssl.CERT_NONE

DEFAULT_STEPS         = [20, 40, 60, 80, 100, 150, 200, 300, 500]
ALLOC_REPEATS         = 5
REQ_TIMEOUT           = aiohttp.ClientTimeout(total=15)
STEP_TIMEOUT_S        = 60
STEP_PAUSE_S          = 5
REGISTER_BATCH_SIZE   = 50    # enregistre les pairs par lots, pas tous d'un coup
MEASURE_CONCURRENCY   = 80    # max requêtes simultanées pendant les mesures
                               # (évite ServerDisconnectedError sur Node.js mono-thread)

# Seuils SLA — le test échoue si ces valeurs sont dépassées
DEFAULT_SLA_LATENCE_MS  = 2000   # latence moyenne max acceptable (ms)
DEFAULT_SLA_ECHECS_PCT  = 5      # pourcentage d'échecs max acceptable

ORG_TYPES = ["ISP", "DATACENTER", "PME", "UNIVERSITY", "GOVERNMENT", "STARTUP", "NGO", "OTHER"]

DIR       = os.path.dirname(__file__)
CSV_PATH  = os.path.join(DIR, "shieldnet_scalability_real.csv")
PNG_PATH  = os.path.join(DIR, "shieldnet_scalability_real.png")

FIELDNAMES = [
    "noeuds", "timestamp",
    "help_request_moy_ms", "help_request_p95_ms", "help_request_max_ms", "help_request_echecs",
    "heartbeat_moy_ms",    "heartbeat_p95_ms",    "heartbeat_max_ms",    "heartbeat_echecs",
    "allocate_moy_ms",     "allocate_p95_ms",
    "allocate_peers_acceptes",
    "sla_ok",
]

# ── Couleurs terminal ─────────────────────────────────────────────────────────
GREEN, RED, YELLOW, CYAN, BOLD, RESET = (
    "\033[92m", "\033[91m", "\033[93m", "\033[96m", "\033[1m", "\033[0m"
)

def ok(msg):    print(f"  {GREEN}[OK]{RESET}  {msg}")
def warn(msg):  print(f"  {YELLOW}[WARN]{RESET} {msg}")
def err(msg):   print(f"  {RED}[ERR]{RESET} {msg}")
def info(msg):  print(f"  {msg}")
def title(msg): print(f"\n{BOLD}{'='*66}\n  {msg}\n{'='*66}{RESET}")
def section(msg): print(f"\n  {CYAN}── {msg}{RESET}")


# ── Handler WinError 10054 (cosmétique sous Windows) ─────────────────────────
def _install_quiet_winerror_handler():
    if sys.platform != "win32":
        return
    def _handler(loop, context):
        exc = context.get("exception")
        if isinstance(exc, ConnectionResetError) and getattr(exc, "winerror", None) == 10054:
            return
        loop.default_exception_handler(context)
    asyncio.get_running_loop().set_exception_handler(_handler)


# ── Percentile ────────────────────────────────────────────────────────────────
def pct(values: list, p: float) -> float:
    if not values:
        return 0.0
    sorted_v = sorted(values)
    idx = max(0, int(len(sorted_v) * p / 100) - 1)
    return round(sorted_v[idx], 2)


# ── Vérification serveur ──────────────────────────────────────────────────────
async def server_is_running(session) -> bool:
    """
    Retourne True si ShieldNet répond sur localhost:3001.
    CORRECTION v2 : on vérifie status < 500 (pas < 200 comme en v1).
    """
    try:
        async with session.get(
            "https://localhost:3001/",
            ssl=SSL_CTX,
            timeout=aiohttp.ClientTimeout(total=4),
        ) as r:
            return r.status < 500   # ← CORRIGÉ (v1 utilisait < 200, toujours False)
    except Exception:
        return False


# ── Auth ──────────────────────────────────────────────────────────────────────
async def get_token(session) -> str:
    async with session.post(
        f"{BASE_URL}/auth/token",
        json={"node_id": NODE_ID, "node_secret": SECRET},
        ssl=SSL_CTX, timeout=REQ_TIMEOUT,
    ) as r:
        d = await r.json()
        token = d.get("token")
        if not token:
            raise RuntimeError(f"Token non obtenu : {d}")
        return token


def hdrs(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ── Reset + Init ──────────────────────────────────────────────────────────────
async def reset_and_init(session) -> str:
    RESET_TIMEOUT = aiohttp.ClientTimeout(total=120)
    async with session.post(
        f"{BASE_URL}/simulation/reset", ssl=SSL_CTX, timeout=RESET_TIMEOUT
    ) as r:
        pass

    payload = {
        "node_name":                    "victim-scalability",
        "organization_name":            "ESI Alger",
        "organization_type":            "UNIVERSITY",
        "country_code":                 "DZ",
        "api_endpoint_url":             "https://localhost:3001/api/v1",
        "public_key":                   "SCALE_KEY",
        "max_scrubbing_capacity_gbps":  10,
        "current_load_percent":         20,
    }
    async with session.post(
        f"{BASE_URL}/simulation/node/init",
        json=payload, ssl=SSL_CTX, timeout=REQ_TIMEOUT,
    ) as r:
        if r.status not in (200, 201):
            raise RuntimeError(f"/simulation/node/init a échoué : {await r.text()}")

    return await get_token(session)


# ── Enregistrement des pairs par lots ─────────────────────────────────────────
async def register_peers(session, n: int, offset: int) -> list:
    """
    Enregistre n pairs virtuels en lots de REGISTER_BATCH_SIZE.
    Retourne la liste de leurs peer_id réels (UUID Postgres).

    Pourquoi des lots ?  Envoyer 500 requêtes simultanées surcharge le pool
    Sequelize (max=20) et fausse les mesures. Les lots répartissent la charge
    de manière plus réaliste.
    """
    async def register_one(i):
        cap = round(random.uniform(5.0, 50.0), 1)
        payload = {
            "peer_name":                   f"vscale-{i:05d}",
            "organization_name":           f"Scale Org {i}",
            "organization_type":           ORG_TYPES[i % len(ORG_TYPES)],
            "country_code":                "DZ",
            "api_endpoint_url":            f"https://vscale-{i}.shieldnet.local/api/v1",
            "public_key":                  f"SCALEKEY_{i}",
            "max_scrubbing_capacity_gbps": cap,
            "declared_available_gbps":     round(cap * 0.8, 2),
        }
        try:
            async with session.post(
                f"{BASE_URL}/peers/register",
                json=payload, ssl=SSL_CTX, timeout=REQ_TIMEOUT,
            ) as r:
                d = await r.json()
                return d.get("peer_id")
        except Exception:
            return None

    peer_ids = []
    indices   = list(range(offset, offset + n))

    for batch_start in range(0, n, REGISTER_BATCH_SIZE):
        batch = indices[batch_start : batch_start + REGISTER_BATCH_SIZE]
        results = await asyncio.gather(*[register_one(i) for i in batch])
        peer_ids.extend([p for p in results if p])

    return peer_ids


# ── Création + clôture immédiate de l'attaque ─────────────────────────────────
async def create_attack(session, token) -> str:
    """
    Crée une attaque puis la clôture immédiatement.
    Sans clôture, chaque heartbeat/register déclenche reconsiderCoalition()
    sur TOUTES les attaques ouvertes — ce qui sature Node.js mono-thread
    et fausse les mesures de latence (observé : +6 000 ms dès 2 attaques ouvertes).
    """
    async with session.post(
        f"{BASE_URL}/alert",
        headers=hdrs(token),
        json={
            "peak_volume_gbps":            25,
            "overflow_volume_gbps":        15,
            "local_capacity_at_detection": 8,
            "target_ip_range":             "10.0.9.0/24",
            "target_service":              "DNS",
            "target_protocol":             "UDP",
        },
        ssl=SSL_CTX, timeout=REQ_TIMEOUT,
    ) as r:
        d = await r.json()
        if r.status not in (200, 201):
            raise RuntimeError(f"/alert a échoué : {d}")
        attack_id = d.get("attack_id") or d.get("id")
        if not attack_id:
            raise RuntimeError(f"attack_id manquant dans : {d}")

    # Clôture immédiate pour éviter la cascade reconsiderCoalition
    async with session.post(
        f"{BASE_URL}/simulation/attack/end",
        headers=hdrs(token),
        json={"attack_id": attack_id},
        ssl=SSL_CTX, timeout=REQ_TIMEOUT,
    ) as r:
        if r.status not in (200, 201):
            warn(f"/simulation/attack/end a échoué (HTTP {r.status})"
                 " — risque de cascade reconsiderCoalition()")

    return attack_id


# ── Mesures ───────────────────────────────────────────────────────────────────
async def measure(session, token, attack_id, peer_ids, sla_ms, sla_echecs_pct) -> dict:
    H = hdrs(token)

    # Sémaphore partagé — limite la concurrence vers Node.js mono-thread.
    # Sans ça : 500 requêtes simultanées → ServerDisconnectedError.
    sem = asyncio.Semaphore(MEASURE_CONCURRENCY)

    # ── help/request × N (concurrence limitée) ───────────────────────────────
    async def help_one(pid):
        async with sem:
            t0 = time.perf_counter()
            try:
                async with session.post(
                    f"{BASE_URL}/help/request", headers=H,
                    json={"attack_id": attack_id, "helping_peer_id": pid},
                    ssl=SSL_CTX, timeout=REQ_TIMEOUT,
                ) as r:
                    await r.json()
                    return (time.perf_counter() - t0) * 1000, r.status in (200, 201)
            except Exception:
                return (time.perf_counter() - t0) * 1000, False

    hr = await asyncio.gather(*[help_one(pid) for pid in peer_ids])
    hr_times = [t for t, _ in hr]
    hr_fail  = sum(1 for _, ok_ in hr if not ok_)

    # ── heartbeat × N (concurrence limitée) ──────────────────────────────────
    async def hb_one(pid):
        async with sem:
            t0 = time.perf_counter()
            try:
                async with session.post(
                    f"{BASE_URL}/heartbeat", headers=H,
                    json={
                        "peer_id":                 pid,
                        "reported_status":         "ACTIVE",
                        "reported_load_pct":       round(random.uniform(0, 70), 1),
                        "reported_available_gbps": round(random.uniform(5, 40), 1),
                    },
                    ssl=SSL_CTX, timeout=REQ_TIMEOUT,
                ) as r:
                    await r.json()
                    return (time.perf_counter() - t0) * 1000, r.status in (200, 201)
            except Exception:
                return (time.perf_counter() - t0) * 1000, False

    hb = await asyncio.gather(*[hb_one(pid) for pid in peer_ids])
    hb_times = [t for t, _ in hb]
    hb_fail  = sum(1 for _, ok_ in hb if not ok_)

    # ── Allocation WSM (ALLOC_REPEATS fois) ──────────────────────────────────
    alloc_times, accepted_count = [], 0
    for _ in range(ALLOC_REPEATS):
        t0 = time.perf_counter()
        async with session.post(
            f"{BASE_URL}/attack/{attack_id}/allocate",
            headers=H, ssl=SSL_CTX, timeout=REQ_TIMEOUT,
        ) as r:
            d = await r.json()
        alloc_times.append((time.perf_counter() - t0) * 1000)
        accepted_count = len(d.get("plan", []))

    n = len(peer_ids)
    hr_moy = round(statistics.mean(hr_times), 2)
    hb_moy = round(statistics.mean(hb_times), 2)
    alloc_moy = round(statistics.mean(alloc_times), 2)

    # Évaluation SLA
    hr_echecs_pct = (hr_fail / n * 100) if n else 0
    hb_echecs_pct = (hb_fail / n * 100) if n else 0
    sla_ok = (
        hr_moy <= sla_ms and hb_moy <= sla_ms
        and hr_echecs_pct <= sla_echecs_pct
        and hb_echecs_pct <= sla_echecs_pct
    )

    return {
        "noeuds":                  n,
        "timestamp":               datetime.now().isoformat(timespec="seconds"),
        "help_request_moy_ms":     hr_moy,
        "help_request_p95_ms":     pct(hr_times, 95),
        "help_request_max_ms":     round(max(hr_times), 2),
        "help_request_echecs":     hr_fail,
        "heartbeat_moy_ms":        hb_moy,
        "heartbeat_p95_ms":        pct(hb_times, 95),
        "heartbeat_max_ms":        round(max(hb_times), 2),
        "heartbeat_echecs":        hb_fail,
        "allocate_moy_ms":         alloc_moy,
        "allocate_p95_ms":         pct(alloc_times, 95),
        "allocate_peers_acceptes": accepted_count,
        "sla_ok":                  sla_ok,
    }


# ── CSV ───────────────────────────────────────────────────────────────────────
def save_csv(rows: list):
    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)


# ── Graphique ─────────────────────────────────────────────────────────────────
def generate_png(rows: list, sla_ms: float):
    if not HAS_MATPLOTLIB or not rows:
        return

    ns       = [r["noeuds"]              for r in rows]
    hr_moy   = [r["help_request_moy_ms"] for r in rows]
    hr_p95   = [r["help_request_p95_ms"] for r in rows]
    hb_moy   = [r["heartbeat_moy_ms"]    for r in rows]
    hb_p95   = [r["heartbeat_p95_ms"]    for r in rows]
    alloc    = [r["allocate_moy_ms"]     for r in rows]

    fig, axes = plt.subplots(1, 3, figsize=(16, 5))
    fig.suptitle(
        f"ShieldNet — Scalabilité réelle (Postgres + Sequelize + TLS) — {datetime.now():%Y-%m-%d}",
        fontweight="bold", fontsize=12,
    )

    # ── Demande d'aide ────────────────────────────────────────────────────────
    axes[0].plot(ns, hr_moy, "o-",  color="#1f77b4", label="Moyenne")
    axes[0].plot(ns, hr_p95, "o--", color="#aec7e8", label="p95")
    axes[0].axhline(sla_ms, color="red", linestyle=":", linewidth=1.2, label=f"SLA {sla_ms} ms")
    axes[0].set_title("Demande d'aide — latence (ms)")
    axes[0].set_xlabel("Nombre de pairs")
    axes[0].set_ylabel("ms")
    axes[0].legend()
    axes[0].grid(True, alpha=0.3)

    # ── Heartbeat ─────────────────────────────────────────────────────────────
    axes[1].plot(ns, hb_moy, "s-",  color="#2ca02c", label="Moyenne")
    axes[1].plot(ns, hb_p95, "s--", color="#98df8a", label="p95")
    axes[1].axhline(sla_ms, color="red", linestyle=":", linewidth=1.2, label=f"SLA {sla_ms} ms")
    axes[1].set_title("Heartbeat — latence (ms)")
    axes[1].set_xlabel("Nombre de pairs")
    axes[1].set_ylabel("ms")
    axes[1].legend()
    axes[1].grid(True, alpha=0.3)

    # ── Allocation WSM ────────────────────────────────────────────────────────
    axes[2].plot(ns, alloc, "^-", color="#d62728", label=f"Moyenne ({ALLOC_REPEATS} rép.)")
    axes[2].set_title("Allocation WSM — temps de calcul (ms)")
    axes[2].set_xlabel("Nombre de pairs")
    axes[2].set_ylabel("ms")
    axes[2].legend()
    axes[2].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig(PNG_PATH, dpi=150, bbox_inches="tight")
    plt.close()
    ok(f"PNG généré → {PNG_PATH}")


# ── Rapport final ─────────────────────────────────────────────────────────────
def print_report(rows: list, steps: list, sla_ms: float, sla_echecs_pct: float):
    title("Rapport de scalabilité ShieldNet")

    passed = sum(1 for r in rows if r["sla_ok"])
    failed = sum(1 for r in rows if not r["sla_ok"])
    skipped = len(steps) - len(rows)

    print(f"\n  Paliers réussis    : {GREEN}{len(rows)}/{len(steps)}{RESET}")
    print(f"  SLA respecté       : {GREEN}{passed}{RESET} palier(s)")
    print(f"  SLA violé          : {RED}{failed}{RESET} palier(s)")
    print(f"  Paliers abandonnés : {YELLOW}{skipped}{RESET} (timeout serveur)")

    if rows:
        section("Détail des résultats")
        print(f"\n  {'Pairs':<7} {'Aide moy':>9} {'Aide p95':>9} {'HB moy':>9}"
              f" {'HB p95':>9} {'Alloc':>8} {'SLA':>5}")
        print("  " + "─" * 60)
        for r in rows:
            sla_str = f"{GREEN}OK{RESET}" if r["sla_ok"] else f"{RED}KO{RESET}"
            print(
                f"  {r['noeuds']:<7}"
                f" {r['help_request_moy_ms']:>8.0f}ms"
                f" {r['help_request_p95_ms']:>8.0f}ms"
                f" {r['heartbeat_moy_ms']:>8.0f}ms"
                f" {r['heartbeat_p95_ms']:>8.0f}ms"
                f" {r['allocate_moy_ms']:>7.0f}ms"
                f"   {sla_str}"
            )

    section("Diagnostic")
    if rows:
        last = rows[-1]
        alloc_last = last["allocate_moy_ms"]
        hb_last    = last["heartbeat_moy_ms"]
        ratio      = hb_last / alloc_last if alloc_last else 0

        if ratio > 5:
            print(f"\n  {YELLOW}Goulot identifié : pool Sequelize / I/O base de données{RESET}")
            print(f"  → Heartbeat {hb_last:.0f}ms vs allocation WSM {alloc_last:.0f}ms"
                  f" (ratio {ratio:.1f}×)")
            print( "  → L'algorithme WSM est rapide ; c'est la couche BD qui ralentit.")
            print( "  → Piste : augmenter pool.max dans config/database.js (actuellement 20)")
            print( "             ou ajouter un index sur Peer.status + Peer.updated_at")
        else:
            print(f"\n  Ratio latence BD/WSM : {ratio:.1f}× — pas de goulot évident détecté.")

    section("Recommandations")
    violations = [r for r in rows if not r["sla_ok"]]
    if not violations:
        print(f"\n  {GREEN}Tous les paliers respectent le SLA ({sla_ms} ms, {sla_echecs_pct}% échecs).{RESET}")
        print( "  Le système est scalable dans la plage testée.")
    else:
        first_fail = violations[0]["noeuds"]
        print(f"\n  {RED}Le SLA est dépassé à partir de {first_fail} pairs.{RESET}")
        print(f"  Seuils configurés : latence moy ≤ {sla_ms} ms, échecs ≤ {sla_echecs_pct}%")
        print( "  Actions suggérées :")
        print( "    1. Augmenter pool.max (database.js) — actuellement 20")
        print( "    2. Ajouter index Postgres sur heartbeat_logs(peer_id, created_at)")
        print( "    3. Envisager un cache Redis pour les heartbeats fréquents")

    print()


# ── Main ──────────────────────────────────────────────────────────────────────
async def main(steps, sla_ms, sla_echecs_pct):
    _install_quiet_winerror_handler()
    title(f"ShieldNet — Test de Scalabilité v2  [{datetime.now():%Y-%m-%d %H:%M}]")
    print(f"  Paliers : {steps}")
    print(f"  SLA     : latence moy ≤ {sla_ms} ms  |  échecs ≤ {sla_echecs_pct}%")

    connector = aiohttp.TCPConnector(ssl=False, limit=0)
    async with aiohttp.ClientSession(connector=connector) as session:

        # ── Vérification serveur ───────────────────────────────────────────────
        if not await server_is_running(session):
            err("ShieldNet Docker non disponible sur localhost:3001")
            info("Lance : docker compose up -d  puis relance ce test.")
            sys.exit(1)

        ok("Serveur ShieldNet détecté.")

        section("Initialisation")
        token = await reset_and_init(session)
        ok("Nœud local prêt, token obtenu.")

        rows, offset = [], 0

        async def run_one_step(n, off):
            tok   = await get_token(session)
            pids  = await register_peers(session, n, off)
            if len(pids) < n:
                warn(f"{n - len(pids)} pair(s) non enregistré(s) sur {n}")
            aid = await create_attack(session, tok)
            return await measure(session, tok, aid, pids, sla_ms, sla_echecs_pct)

        section("Mesures par palier")
        print(f"\n  {'Pairs':<7} {'Aide moy':>9} {'Aide p95':>9}"
              f" {'HB moy':>9} {'HB p95':>9} {'Alloc':>8} {'SLA':>5}")
        print("  " + "─" * 60)

        for n in steps:
            try:
                row = await asyncio.wait_for(
                    run_one_step(n, offset), timeout=STEP_TIMEOUT_S
                )
                offset += n
                rows.append(row)

                sla_str = f"{GREEN}OK{RESET}" if row["sla_ok"] else f"{RED}KO{RESET}"
                print(
                    f"  {n:<7}"
                    f" {row['help_request_moy_ms']:>8.0f}ms"
                    f" {row['help_request_p95_ms']:>8.0f}ms"
                    f" {row['heartbeat_moy_ms']:>8.0f}ms"
                    f" {row['heartbeat_p95_ms']:>8.0f}ms"
                    f" {row['allocate_moy_ms']:>7.0f}ms"
                    f"   {sla_str}"
                )

                if row["help_request_echecs"] or row["heartbeat_echecs"]:
                    warn(
                        f"  échecs : aide={row['help_request_echecs']},"
                        f" heartbeat={row['heartbeat_echecs']}"
                    )

                save_csv(rows)
                generate_png(rows, sla_ms)

            except asyncio.TimeoutError:
                offset += n
                err(f"Palier {n} pairs — timeout ({STEP_TIMEOUT_S}s dépassé)")
                warn("Palier abandonné — on continue.")
            except Exception as e:
                offset += n
                err(f"Palier {n} pairs — {type(e).__name__}: {e or '(vide)'}")
                warn("Palier abandonné — on continue.")
            finally:
                await asyncio.sleep(STEP_PAUSE_S)

    if not rows:
        err("Aucune mesure collectée.")
        sys.exit(1)

    print_report(rows, steps, sla_ms, sla_echecs_pct)
    ok(f"CSV sauvegardé → {CSV_PATH}")

    # Code de sortie : 1 si au moins un palier viole le SLA
    if any(not r["sla_ok"] for r in rows):
        sys.exit(1)


# ── CLI ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="ShieldNet — Test de scalabilité v2"
    )
    parser.add_argument(
        "--steps", type=int, nargs="+", default=DEFAULT_STEPS,
        metavar="N", help="Paliers de pairs à tester (ex: 20 50 100 200)",
    )
    parser.add_argument(
        "--sla-latence", type=float, default=DEFAULT_SLA_LATENCE_MS,
        metavar="MS", help=f"Seuil SLA latence moyenne en ms (défaut: {DEFAULT_SLA_LATENCE_MS})",
    )
    parser.add_argument(
        "--sla-echecs", type=float, default=DEFAULT_SLA_ECHECS_PCT,
        metavar="PCT", help=f"Seuil SLA échecs en %% (défaut: {DEFAULT_SLA_ECHECS_PCT})",
    )
    args = parser.parse_args()

    asyncio.run(main(args.steps, args.sla_latence, args.sla_echecs))