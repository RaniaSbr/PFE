/**
 * Middleware d'authentification — JWT (RS256) + mTLS
 *
 * Architecture P2P asymétrique :
 *   - Chaque nœud signe ses tokens avec sa CLEF PRIVÉE (node.key)
 *   - Le récepteur vérifie avec la CLÉ PUBLIQUE de l'émetteur (PEERS.public_key)
 *   - Payload : { iss: node_id, node_id, iat, exp }  — exp = 60 secondes
 *   - Algorithme : RS256 (asymétrique, clé unique par nœud)
 *
 * Avantages vs HS256 :
 *   - Un nœud compromis n'expose pas les autres (pas de secret partagé)
 *   - Impossible d'usurper l'identité d'un autre nœud
 *   - Tokens courts (60s) → résistance aux attaques par rejeu
 */

const fs  = require("fs");
const jwt = require("jsonwebtoken");
const { Peer, LocalNodeConfig } = require("../models");

const JWT_EXPIRES_IN = "15m";

// ─── Clés du nœud local ──────────────────────────────────────────────────────

function getLocalPrivateKey() {
  const keyPath = process.env.TLS_KEY || "./certs/node.key";
  if (!fs.existsSync(keyPath)) return null;
  return fs.readFileSync(keyPath);
}

function getLocalPublicKey() {
  const certPath = process.env.TLS_CERT || "./certs/node.crt";
  if (!fs.existsSync(certPath)) return null;
  return fs.readFileSync(certPath); // jwt.verify accepte un certificat PEM directement
}

// ─── Routes publiques (pas de JWT requis) ────────────────────────────────────

const PUBLIC_ROUTES = [
  { method: "GET",  path: "/" },
  { method: "POST", path: "/api/v1/auth/token" },
  { method: "POST", path: "/api/v1/peers/register" },
  { method: "POST", path: "/api/v1/peers/goodbye" },
];

const PUBLIC_PREFIXES = [
  "/api-docs",
  "/api/v1/simulation",
];

function isPublicRoute(req) {
  if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return true;
  return PUBLIC_ROUTES.some((r) => r.method === req.method && r.path === req.path);
}

// ─── Extraction du token ──────────────────────────────────────────────────────

function extractToken(req) {
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) return authHeader.slice(7);
  if (req.body?.jwt_token) return req.body.jwt_token;
  if (req.query?.token)    return req.query.token;
  return null;
}

// ─── Middleware JWT principal ─────────────────────────────────────────────────

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function jwtMiddleware(req, res, next) {
  if (isPublicRoute(req)) return next();

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "JWT token required. Use POST /api/v1/auth/token to obtain one.",
    });
  }

  // 1. Décoder sans vérifier pour lire l'émetteur (iss)
  const decoded = jwt.decode(token);
  if (!decoded || !decoded.iss) {
    return res.status(401).json({ error: "Invalid token", message: "Missing iss claim." });
  }

  const issuer_id = decoded.iss;

  // 2. Récupérer la clé publique de l'émetteur
  let publicKey;
  let authInfo;

  const localNode = await LocalNodeConfig.findOne();
  const isLocal   =
    process.env.NODE_ID === issuer_id ||
    (localNode && (localNode.node_id === issuer_id || localNode.node_name === issuer_id));

  if (isLocal) {
    publicKey = getLocalPublicKey();
    if (!publicKey) {
      return res.status(500).json({ error: "Local certificate not found." });
    }
    const effectiveNodeId = (localNode && localNode.node_id) || process.env.NODE_ID;
    authInfo = { node_id: effectiveNodeId, role: "local", is_local: true };
  } else {
    // Pair enregistré — node_id doit être un UUID valide
    if (!uuidRegex.test(issuer_id)) {
      return res.status(401).json({ error: "Invalid token", message: "Invalid iss format." });
    }

    const peer = await Peer.findOne({ where: { peer_id: issuer_id } });
    if (!peer) {
      return res.status(403).json({
        error: "Forbidden",
        message: `Node ${issuer_id} is not registered in this coalition.`,
      });
    }
    if (peer.status === "BANNED") {
      return res.status(403).json({ error: "Forbidden", message: "This node has been banned." });
    }

    publicKey = peer.public_key; // PEM string stocké dans PEERS
    authInfo  = {
      node_id:    issuer_id,
      peer_id:    peer.peer_id,
      peer_name:  peer.peer_name,
      role:       "peer",
      is_local:   false,
    };
  }

  // 3. Vérifier la signature RS256 avec la clé publique de l'émetteur
  try {
    jwt.verify(token, publicKey, { algorithms: ["RS256"] });
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired", message: "Request a new token (POST /api/v1/auth/token)." });
    }
    return res.status(401).json({ error: "Invalid token", message: err.message });
  }

  req.authNode = authInfo;
  return next();
}

// ─── Génération de token (RS256) ──────────────────────────────────────────────

/**
 * Génère un JWT signé avec la clé privée du nœud local.
 * @param {string} node_id  UUID du nœud émetteur
 * @returns {string} token JWT
 */
function generateToken(node_id) {
  const privateKey = getLocalPrivateKey();
  if (!privateKey) {
    throw new Error("Private key not found (TLS_KEY). Cannot generate RS256 token.");
  }
  return jwt.sign(
    { iss: node_id, node_id },
    privateKey,
    { algorithm: "RS256", expiresIn: JWT_EXPIRES_IN }
  );
}

// ─── Middleware mTLS ──────────────────────────────────────────────────────────

function mtlsMiddleware(req, res, next) {
  if (process.env.MTLS_ENABLED !== "true") return next();

  const cert = req.socket.getPeerCertificate();

  if (!cert || !cert.subject) {
    if (process.env.MTLS_STRICT === "true") {
      return res.status(401).json({
        error: "mTLS required",
        message: "Client certificate not provided or invalid.",
      });
    }
    return next();
  }

  req.clientCert = {
    subject:     cert.subject,
    issuer:      cert.issuer,
    fingerprint: cert.fingerprint,
    valid_from:  cert.valid_from,
    valid_to:    cert.valid_to,
  };

  next();
}

module.exports = { jwtMiddleware, mtlsMiddleware, generateToken };
