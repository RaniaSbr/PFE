const express = require("express");
const { Op } = require("sequelize");
const {
  Attack,
  AuditLog,
  HelpSession,
  LocalNodeConfig,
  MessageLog,
  Peer,
} = require("../models");

const router = express.Router();

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

    const { count, rows } = await MessageLog.findAndCountAll({
      where,
      order: [["timestamp", "DESC"]],
      limit,
      offset,
    });

    return res.json({ total: count, limit, offset, messages: rows });
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
