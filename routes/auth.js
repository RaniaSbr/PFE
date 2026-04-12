/**
 * Route d'authentification — génération de tokens JWT (RS256)
 *
 * POST /api/v1/auth/token
 *   Body : { node_id, node_secret }
 *   Retourne : { token, expires_in, node_id, role }
 *
 * Fonctionnement :
 *   - Le nœud s'authentifie avec son node_id + node_secret (JWT_SECRET local)
 *   - Le serveur génère un JWT signé avec la CLÉ PRIVÉE du nœud local (RS256)
 *   - Le token est valable 60 secondes (anti-rejeu)
 *
 * Vérification côté récepteur :
 *   - Lit le claim `iss` (issuer = node_id de l'émetteur)
 *   - Récupère la clé publique du pair dans PEERS.public_key
 *   - Vérifie la signature RS256
 */

const express = require("express");
const { Peer, LocalNodeConfig } = require("../models");
const { generateToken } = require("../middleware/auth");

const router = express.Router();

const JWT_SECRET    = process.env.JWT_SECRET    || "shieldnet-secret-key-2025";
const JWT_EXPIRES_IN = "60s";

/**
 * @swagger
 * /auth/token:
 *   post:
 *     tags: [Auth]
 *     summary: Obtenir un token JWT (RS256, 60s)
 *     description: >
 *       Génère un JWT signé avec la clé privée du nœud local (RS256).
 *       Le token est valable 60 secondes pour limiter les attaques par rejeu.
 *       Le nœud récepteur vérifiera la signature avec la clé publique de l'émetteur.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [node_id, node_secret]
 *             properties:
 *               node_id:
 *                 type: string
 *                 description: "UUID du nœud ou node_name local (ex: node-university)"
 *               node_secret:
 *                 type: string
 *                 description: "JWT_SECRET configuré dans le .env du nœud"
 *     responses:
 *       200:
 *         description: Token JWT RS256 généré
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:       { type: string, description: "JWT signé RS256" }
 *                 expires_in:  { type: string, example: "60s" }
 *                 node_id:     { type: string }
 *                 role:        { type: string, enum: [local, peer] }
 *                 algorithm:   { type: string, example: "RS256" }
 *       401:
 *         description: Identifiants invalides
 *       500:
 *         description: Clé privée introuvable
 */
router.post("/auth/token", async (req, res) => {
  try {
    const { node_id, node_secret } = req.body;

    if (!node_id || !node_secret) {
      return res.status(400).json({ error: "node_id and node_secret are required" });
    }

    // ── Cas 1 : nœud local ───────────────────────────────────────────────────
    const localNode = await LocalNodeConfig.findOne();
    const isLocalNode =
      process.env.NODE_ID   === node_id ||
      process.env.NODE_NAME === node_id ||
      (localNode && (localNode.node_id === node_id || localNode.node_name === node_id));

    if (isLocalNode) {
      if (node_secret !== JWT_SECRET) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      // Si LocalNodeConfig n'est pas encore initialisé, on utilise NODE_ID de l'env
      const effectiveNodeId = (localNode && localNode.node_id) || process.env.NODE_ID || node_id;

      let token;
      try {
        token = generateToken(effectiveNodeId);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }

      return res.json({
        token,
        expires_in: JWT_EXPIRES_IN,
        node_id:    effectiveNodeId,
        role:       "local",
        algorithm:  "RS256",
      });
    }

    // ── Cas 2 : pair enregistré ───────────────────────────────────────────────
    // Chaque pair possède sa propre clé privée et génère ses tokens lui-même.
    // Cet endpoint peut néanmoins générer un token pour un pair si son public_key
    // est enregistrée (le pair prouve qu'il connaît son propre secret local).
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(node_id)) {
      return res.status(401).json({ error: "Unknown node" });
    }

    const peer = await Peer.findOne({ where: { peer_id: node_id } });
    if (!peer) {
      return res.status(401).json({ error: "Unknown node" });
    }
    if (peer.status === "BANNED") {
      return res.status(403).json({ error: "Node is banned from this coalition" });
    }

    // Le secret du pair = sa clé publique enregistrée (preuve d'identité prototype)
    // En production : challenge-response avec la clé privée
    if (node_secret !== peer.public_key) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Note : ici on signe avec la clé privée DU NŒUD LOCAL (le serveur qui répond).
    // En architecture P2P complète, chaque nœud signerait avec sa propre clé privée.
    let token;
    try {
      token = generateToken(node_id);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    return res.json({
      token,
      expires_in: JWT_EXPIRES_IN,
      node_id,
      role:       "peer",
      peer_name:  peer.peer_name,
      algorithm:  "RS256",
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
