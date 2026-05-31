const express = require("express");
const { Op } = require("sequelize");
const {
  Attack,
  AuditLog,
  HeartbeatLog,
  HelpSession,
  LocalNodeConfig,
  MessageLog,
  Peer,
} = require("../models");

const router = express.Router();

/**
 * @swagger
 * /metrics:
 *   get:
 *     tags: [Monitoring]
 *     summary: Métriques globales du nœud
 *     responses:
 *       200:
 *         description: Métriques
 *
 * /logs/messages:
 *   get:
 *     tags: [Monitoring]
 *     summary: Logs des messages P2P
 *     parameters:
 *       - in: query
 *         name: direction
 *         schema: { type: string, enum: [SENT, RECEIVED] }
 *       - in: query
 *         name: message_type
 *         schema: { type: string }
 *       - in: query
 *         name: peer_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Logs messages
 *
 * /logs/audit:
 *   get:
 *     tags: [Monitoring]
 *     summary: Logs d'audit
 *     parameters:
 *       - in: query
 *         name: severity
 *         schema: { type: string, enum: [INFO, WARNING, CRITICAL] }
 *       - in: query
 *         name: event_type
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Logs audit
 */

const ACTIVE_SESSION_STATUSES = ["REQUESTED", "OFFERED", "NEGOTIATING", "ACCEPTED", "ACTIVE"];

// GET /metrics
router.get("/metrics", async (req, res) => {
  try {
    const node = await LocalNodeConfig.findOne();

    const [totalPeers, activePeers, activeSessions, totalAttacks, openAttacks] = await Promise.all([
      Peer.count(),
      Peer.count({ where: { status: "ACTIVE" } }),
      HelpSession.count({ where: { status: { [Op.in]: ACTIVE_SESSION_STATUSES } } }),
      Attack.count(),
      Attack.count({ where: { status: { [Op.notIn]: ["ENDED", "MITIGATED"] } } }),
    ]);

    const loadPercent = Number(node?.current_load_percent || 0);
    const maxCapacity = Number(node?.max_scrubbing_capacity_gbps || 0);
    const availableGbps = Math.max(0, maxCapacity * (1 - loadPercent / 100));

    return res.json({
      node_id: node?.node_id || null,
      current_load_pct: loadPercent,
      available_gbps: Number(availableGbps.toFixed(2)),
      connected_peers: totalPeers,
      active_peers: activePeers,
      active_sessions: activeSessions,
      total_attacks: totalAttacks,
      open_attacks: openAttacks,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /incidents
router.get("/incidents", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 20);
    const attacks = await Attack.findAll({
      order: [["detected_at", "DESC"]],
      limit,
    });

    return res.json(attacks);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /attacks/:id
router.get("/attacks/:id", async (req, res) => {
  try {
    const attack = await Attack.findByPk(req.params.id);
    if (!attack) return res.status(404).json({ error: "Attack not found" });
    return res.json(attack);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// PATCH /attacks/:id
router.patch("/attacks/:id", async (req, res) => {
  try {
    const attack = await Attack.findByPk(req.params.id);
    if (!attack) return res.status(404).json({ error: "Attack not found" });
    const allowed = ["status", "coalition_helped", "nb_peers_involved", "ended_at", "duration_seconds"];
    const updates = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    await attack.update(updates);
    return res.json(attack);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// GET /logs/messages
router.get("/logs/messages", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    const where = {};

    if (req.query.direction) where.direction = req.query.direction;
    if (req.query.message_type) where.message_type = req.query.message_type;
    if (req.query.peer_id) where.peer_id = req.query.peer_id;
    if (req.query.processing_result) where.processing_result = req.query.processing_result;

    const localNode = await LocalNodeConfig.findOne({ attributes: ["node_id", "node_name"] });

    const { count, rows } = await MessageLog.findAndCountAll({
      where,
      order: [["timestamp", "DESC"]],
      include: [{ model: Peer, as: "peer", attributes: ["peer_name", "organization_name"] }],
      limit,
      offset,
    });

    // Pour les heartbeats, récupérer les infos de charge depuis HEARTBEAT_LOG
    const hbPeerIds = [...new Set(
      rows.filter(m => m.message_type === "HEARTBEAT" || m.message_type === "HELLO")
          .map(m => m.peer_id)
    )];
    const latestHb = {};
    if (hbPeerIds.length > 0) {
      const hbs = await HeartbeatLog.findAll({
        where: { peer_id: hbPeerIds },
        order: [["received_at", "DESC"]],
        limit: hbPeerIds.length * 3,
      });
      hbs.forEach(h => { if (!latestHb[h.peer_id]) latestHb[h.peer_id] = h; });
    }

    const messages = rows.map(m => {
      const hb = latestHb[m.peer_id];
      return {
        ...m.toJSON(),
        source:               m.direction === "RECEIVED" ? (m.peer?.peer_name || m.peer_id) : (localNode?.node_name || "local"),
        destination:          m.direction === "SENT"     ? (m.peer?.peer_name || m.peer_id) : (localNode?.node_name || "local"),
        reported_load_pct:    hb?.reported_load_pct    ?? null,
        reported_available_gbps: hb?.reported_available_gbps ?? null,
        reported_status:      hb?.reported_status      ?? null,
      };
    });

    return res.json({ total: count, limit, offset, messages });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /logs/audit
router.get("/logs/audit", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
    const offset = Number(req.query.offset || 0);
    const where = {};

    if (req.query.severity) where.severity = req.query.severity;
    if (req.query.event_type) where.event_type = req.query.event_type;

    const { count, rows } = await AuditLog.findAndCountAll({
      where,
      order: [["timestamp", "DESC"]],
      limit,
      offset,
    });

    return res.json({ total: count, limit, offset, events: rows });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
