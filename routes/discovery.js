const express = require("express");
const { Op } = require("sequelize");
const {
  sequelize,
  HeartbeatLog,
  HelpSession,
  LocalNodeConfig,
  Peer,
  PeerCapability,
  PolicyConfig,
  ReciprocityLedger,
  TrustScore,
} = require("../models");
const { logAudit, logMessage } = require("../utils/logger");

const router = express.Router();

/**
 * @swagger
 * /peers/register:
 *   post:
 *     tags: [Discovery]
 *     summary: Enregistrer ou mettre à jour un pair
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [peer_name, organization_name, organization_type, tier, country_code, api_endpoint_url, public_key]
 *             properties:
 *               peer_name: { type: string }
 *               organization_name: { type: string }
 *               organization_type: { type: string, enum: [UNIVERSITY, ISP, DATACENTER, PME, GOVERNMENT, RESEARCH] }
 *               tier: { type: string, enum: [T1, T2, T3] }
 *               country_code: { type: string }
 *               api_endpoint_url: { type: string }
 *               public_key: { type: string }
 *               ip_address: { type: string }
 *               api_port: { type: integer }
 *               max_scrubbing_capacity_gbps: { type: number }
 *     responses:
 *       201:
 *         description: Pair créé
 *       200:
 *         description: Pair mis à jour
 *       400:
 *         description: Données invalides
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *
 * /peers:
 *   get:
 *     tags: [Discovery]
 *     summary: Lister tous les pairs
 *     responses:
 *       200:
 *         description: Liste des pairs
 *
 * /peers/{peer_id}:
 *   get:
 *     tags: [Discovery]
 *     summary: Détail d'un pair
 *     parameters:
 *       - in: path
 *         name: peer_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Pair trouvé
 *       404:
 *         description: Pair introuvable
 *   delete:
 *     tags: [Discovery]
 *     summary: Supprimer un pair
 *     parameters:
 *       - in: path
 *         name: peer_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Pair supprimé
 *       404:
 *         description: Pair introuvable
 *
 * /heartbeat:
 *   post:
 *     tags: [Discovery]
 *     summary: Envoyer un heartbeat
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [peer_id]
 *             properties:
 *               peer_id: { type: string, format: uuid }
 *               current_load_percent: { type: number }
 *               available_capacity_gbps: { type: number }
 *     responses:
 *       200:
 *         description: Heartbeat enregistré
 *
 * /goodbye:
 *   post:
 *     tags: [Discovery]
 *     summary: Déconnexion propre d'un pair
 *     responses:
 *       200:
 *         description: Pair déconnecté
 *
 * /node/state:
 *   get:
 *     tags: [Discovery]
 *     summary: État actuel du nœud local
 *     responses:
 *       200:
 *         description: État du nœud
 *
 * /capability/advertise:
 *   post:
 *     tags: [Discovery]
 *     summary: Publier les capacités du nœud local
 *     responses:
 *       200:
 *         description: Capacités publiées
 */

const ACTIVE_SESSION_STATUSES = ["REQUESTED", "OFFERED", "NEGOTIATING", "ACCEPTED", "ACTIVE"];

function resolveNodeState(loadPercent, policy) {
  const load = Number(loadPercent || 0);
  const alertThreshold = Number(policy?.alert_threshold_pct ?? 70);
  const escalationThreshold = Number(policy?.escalation_threshold_pct ?? 85);
  const criticalThreshold = Number(policy?.critical_threshold_pct ?? 95);

  if (load > criticalThreshold) return "CRITICAL";
  if (load > escalationThreshold) return "ESCALATION";
  if (load > alertThreshold) return "ALERT";
  return "NORMAL";
}

// GET /status
router.get("/status", async (req, res) => {
  try {
    const node = await LocalNodeConfig.findOne();

    if (!node) {
      return res.status(404).json({ error: "Local node configuration not found" });
    }

    const [policy, activeSessions] = await Promise.all([
      PolicyConfig.findOne({
        where: { node_id: node.node_id, is_current: true },
        order: [["created_at", "DESC"]],
      }),
      HelpSession.count({
        where: { status: { [Op.in]: ACTIVE_SESSION_STATUSES } },
      }),
    ]);

    const maxCapacity = Number(node.max_scrubbing_capacity_gbps || 0);
    const loadPercent = Number(node.current_load_percent || 0);
    const availableGbps = Math.max(0, maxCapacity * (1 - loadPercent / 100));

    return res.json({
      node_id: node.node_id,
      node_name: node.node_name,
      status: node.status,
      current_state: resolveNodeState(loadPercent, policy),
      current_load_pct: loadPercent,
      available_gbps: Number(availableGbps.toFixed(2)),
      active_sessions: activeSessions,
      api_endpoint_url: node.api_endpoint_url,
      last_updated: node.last_updated,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /heartbeat
router.post("/heartbeat", async (req, res) => {
  try {
    const {
      peer_id,
      reported_status,
      reported_load_pct,
      reported_available_gbps,
      round_trip_time_ms,
    } = req.body;

    if (!peer_id || !reported_status || reported_load_pct === undefined || reported_available_gbps === undefined) {
      return res.status(400).json({
        error: "peer_id, reported_status, reported_load_pct and reported_available_gbps are required",
      });
    }

    const peer = await Peer.findByPk(peer_id);

    if (!peer) {
      return res.status(404).json({ error: "Unknown peer" });
    }

    const heartbeat = await HeartbeatLog.create({
      peer_id,
      reported_status,
      reported_load_pct,
      reported_available_gbps,
      round_trip_time_ms,
    });

    await peer.update({
      last_heartbeat: new Date(),
      declared_available_gbps: reported_available_gbps,
      measured_latency_ms: round_trip_time_ms ?? peer.measured_latency_ms,
      consecutive_missed_heartbeats: 0,
      status: peer.status === "BANNED" ? "BANNED" : "ACTIVE",
      updated_at: new Date(),
    });

    logMessage({ message_type: "HEARTBEAT", direction: "RECEIVED", peer_id, priority: "LOW" });

    return res.status(201).json({ message: "Heartbeat recorded", heartbeat });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /peers/register
router.post("/peers/register", async (req, res) => {
  try {
    const { capabilities = [], ...peerPayload } = req.body;
    const now = new Date();
    let created = false;

    const peerId = await sequelize.transaction(async (transaction) => {
      let peer = peerPayload.peer_id ? await Peer.findByPk(peerPayload.peer_id, { transaction }) : null;

      const payload = {
        ...peerPayload,
        first_seen: peerPayload.first_seen || now,
        updated_at: now,
      };

      if (peer) {
        await peer.update(payload, { transaction });
      } else {
        created = true;
        peer = await Peer.create(
          { ...payload, created_at: peerPayload.created_at || now },
          { transaction },
        );
      }

      for (const capability of capabilities) {
        const existingCapability = await PeerCapability.findOne({
          where: { peer_id: peer.peer_id },
          transaction,
        });

        const capabilityValues = {
          peer_id: peer.peer_id,
          declared_capacity_gbps: capability.declared_capacity_gbps ?? capability.capacity_gbps ?? 0,
          verified: capability.verified ?? false,
          verified_at: capability.verified_at ?? null,
          last_updated: now,
        };

        if (existingCapability) {
          await existingCapability.update(capabilityValues, { transaction });
        } else {
          await PeerCapability.create(capabilityValues, { transaction });
        }
      }

      return peer.peer_id;
    });

    const peer = await Peer.findByPk(peerId, {
      include: [{ model: PeerCapability, as: "capabilities" }],
    });

    logMessage({ message_type: "HELLO", direction: "RECEIVED", peer_id: peerId, priority: "NORMAL" });

    if (created) {
      await ReciprocityLedger.findOrCreate({
        where: { peer_id: peerId },
        defaults: { peer_id: peerId, credits_received: 0, credits_given: 0, balance: 0 },
      });

      logAudit({
        event_type: "PEER_ADDED",
        severity: "INFO",
        actor: peerId,
        target: peerId,
        description: `New peer registered: ${peer.peer_name} (${peer.organization_name})`,
      });
    }

    return res.status(created ? 201 : 200).json(peer);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// GET /peers
router.get("/peers", async (req, res) => {
  try {
    const peers = await Peer.findAll({
      include: [{ model: PeerCapability, as: "capabilities" }],
      order: [["created_at", "DESC"]],
    });

    return res.json(peers);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /peers/:peer_id
router.get("/peers/:peer_id", async (req, res) => {
  try {
    const peer = await Peer.findByPk(req.params.peer_id, {
      include: [
        { model: PeerCapability, as: "capabilities" },
        { model: TrustScore, as: "trust_score" },
        { model: ReciprocityLedger, as: "reciprocity_ledger" },
      ],
    });

    if (!peer) {
      return res.status(404).json({ error: "Peer not found" });
    }

    return res.json(peer);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /peers/:peer_id
router.delete("/peers/:peer_id", async (req, res) => {
  try {
    const peer = await Peer.findByPk(req.params.peer_id);

    if (!peer) {
      return res.status(404).json({ error: "Peer not found" });
    }

    const peerName = peer.peer_name;
    await peer.destroy();

    logAudit({
      event_type: "PEER_REMOVED",
      severity: "WARNING",
      actor: "system",
      target: req.params.peer_id,
      description: `Peer removed: ${peerName} (${req.params.peer_id})`,
    });

    return res.json({ message: "Peer deleted" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /peers/discover
router.post("/peers/discover", async (req, res) => {
  try {
    const maxResults = Number(req.body.max_results ?? 10);
    const where = {
      status: { [Op.ne]: "BANNED" },
      membership_status: { [Op.ne]: "EXPELLED" },
    };

    if (req.body.preferred_tier) {
      where.tier = req.body.preferred_tier;
    }

    const peers = await Peer.findAll({
      where,
      include: [{ model: PeerCapability, as: "capabilities" }],
      order: [["updated_at", "DESC"]],
      limit: maxResults,
    });

    return res.json({ count: peers.length, peers });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /peers/goodbye
router.post("/peers/goodbye", async (req, res) => {
  try {
    const { peer_id, reason, estimated_return } = req.body;

    if (!peer_id) {
      return res.status(400).json({ error: "peer_id is required" });
    }

    const peer = await Peer.findByPk(peer_id);

    if (!peer) {
      return res.status(404).json({ error: "Peer not found" });
    }

    const nextStatus = reason === "MAINTENANCE" ? "MAINTENANCE" : "INACTIVE";

    await peer.update({ status: nextStatus, updated_at: new Date() });

    logMessage({ message_type: "GOODBYE", direction: "RECEIVED", peer_id, priority: "NORMAL" });

    return res.json({
      message: "Peer status updated",
      peer_id,
      status: nextStatus,
      estimated_return: estimated_return || null,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /capability/advertise
router.post("/capability/advertise", async (req, res) => {
  try {
    const { peer_id, capabilities } = req.body;

    if (!peer_id || !Array.isArray(capabilities)) {
      return res.status(400).json({ error: "peer_id and capabilities[] are required" });
    }

    const peer = await Peer.findByPk(peer_id);

    if (!peer) {
      return res.status(404).json({ error: "Peer not found" });
    }

    const now = new Date();

    await sequelize.transaction(async (transaction) => {
      for (const capability of capabilities) {
        const existingCapability = await PeerCapability.findOne({
          where: { peer_id },
          transaction,
        });

        const values = {
          peer_id,
          declared_capacity_gbps: capability.capacity_gbps ?? capability.declared_capacity_gbps ?? 0,
          verified: capability.verified ?? false,
          verified_at: capability.verified_at ?? null,
          last_updated: now,
        };

        if (existingCapability) {
          await existingCapability.update(values, { transaction });
        } else {
          await PeerCapability.create(values, { transaction });
        }
      }

      await peer.update({ updated_at: now }, { transaction });
    });

    logMessage({ message_type: "CAPABILITY_ADV", direction: "RECEIVED", peer_id, priority: "LOW" });

    const updatedPeer = await Peer.findByPk(peer_id, {
      include: [{ model: PeerCapability, as: "capabilities" }],
    });

    return res.json(updatedPeer);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

module.exports = router;
