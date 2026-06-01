"""
tests/node_utils.py
Utilitaires partagés entre functional_test.py et scalability_test.py.
"""

import hashlib
import time

SECRET    = "shieldnet-2025"
TOKEN_TTL = 3600


def make_token(node_id: str) -> str:
    exp  = int(time.time()) + TOKEN_TTL
    body = f"{node_id}:{exp}"
    sig  = hashlib.sha256(f"{body}:{SECRET}".encode()).hexdigest()[:16]
    return f"{body}:{sig}"


def check_token(token: str):
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


def need_auth(fn):
    """Décorateur JWT pour les handlers aiohttp in-process."""
    from aiohttp import web

    async def wrapper(req):
        hdr = req.headers.get("Authorization", "")
        tok = hdr[7:] if hdr.startswith("Bearer ") else None
        if not tok or not check_token(tok):
            return web.json_response({"error": "Unauthorized"}, status=401)
        req["caller"] = check_token(tok)
        return await fn(req)
    return wrapper
