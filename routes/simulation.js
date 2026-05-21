const express = require("express");
const {
  Attack,
  LocalNodeConfig,
  PolicyConfig,
  ScrubbingCapability,
  Peer,
  PeerCapability,
  TrustScore,
  TrustViolation,
  ReciprocityLedger,
  ReciprocityTransaction,
  HelpSession,
  HeartbeatLog,
  MessageLog,
  AuditLog,
} = require("../models");
const { logAudit } = require("../utils/logger");

const router = express.Router();

/**
 * @swagger
 * /simulation/node/init:
 *   post:
 *     tags: [Simulation]
 *     summary: Initialiser le nœud local
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [node_name, organization_name, organization_type, tier, country_code, api_endpoint_url, public_key, max_scrubbing_capacity_gbps]
 *             properties:
 *               node_name: { type: string }
 *               organization_name: { type: string }
 *               organization_type: { type: string, enum: [UNIVERSITY, ISP, DATACENTER, PME, GOVERNMENT, RESEARCH] }
 *               tier: { type: string, enum: [T1, T2, T3] }
 *               country_code: { type: string }
 *               api_endpoint_url: { type: string }
 *               public_key: { type: string }
 *               max_scrubbing_capacity_gbps: { type: number }
 *               current_load_percent: { type: number }
 *     responses:
 *       200:
 *         description: Nœud initialisé
 *
 * /simulation/attack/detect:
 *   post:
 *     tags: [Simulation]
 *     summary: Simuler la détection d'une attaque
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [volume_gbps, severity, target_ip_range]
 *             properties:
 *               volume_gbps: { type: number }
 *               severity: { type: string, enum: [LOW, MEDIUM, HIGH, CRITICAL] }
 *               target_ip_range: { type: string }
 *               target_service: { type: string }
 *     responses:
 *       201:
 *         description: Attaque créée
 *
 * /simulation/attack/end:
 *   post:
 *     tags: [Simulation]
 *     summary: Simuler la fin d'une attaque
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [attack_id]
 *             properties:
 *               attack_id: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Attaque terminée
 *
 * /simulation/ping:
 *   get:
 *     tags: [Simulation]
 *     summary: Vérifier que les routes simulation sont actives
 *     responses:
 *       200:
 *         description: OK
 */

// GET /simulation/ping
router.get("/simulation/ping", (req, res) => {
  res.json({
    message: "Simulation routes are ready",
    timestamp: new Date().toISOString(),
  });
});

// POST /simulation/reset
// Remet la base à zéro pour un démarrage propre de la démo (ordre respecte les FK)
router.post("/simulation/reset", async (req, res) => {
  try {
    await ReciprocityTransaction.destroy({ where: {}, truncate: false });
    await ReciprocityLedger.destroy({ where: {}, truncate: false });
    await TrustViolation.destroy({ where: {}, truncate: false });
    await TrustScore.destroy({ where: {}, truncate: false });
    await HeartbeatLog.destroy({ where: {}, truncate: false });
    await HelpSession.destroy({ where: {}, truncate: false });
    await Attack.destroy({ where: {}, truncate: false });
    await PeerCapability.destroy({ where: {}, truncate: false });
    await Peer.destroy({ where: {}, truncate: false });
    await MessageLog.destroy({ where: {}, truncate: false });
    await AuditLog.destroy({ where: {}, truncate: false });
    await ScrubbingCapability.destroy({ where: {}, truncate: false });
    await PolicyConfig.destroy({ where: {}, truncate: false });
    await LocalNodeConfig.destroy({ where: {}, truncate: false });

    return res.json({ message: "Node reset — all demo data cleared." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /simulation/node/init
// Initialise ou met à jour la configuration du nœud local
router.post("/simulation/node/init", async (req, res) => {
  try {
    const required = [
      "node_name",
      "organization_name",
      "organization_type",
      "tier",
      "country_code",
      "api_endpoint_url",
      "public_key",
      "max_scrubbing_capacity_gbps",
    ];

    for (const field of required) {
      if (req.body[field] === undefined || req.body[field] === null) {
        return res.status(400).json({ error: `${field} is required` });
      }
    }

    let node = await LocalNodeConfig.findOne();
    let created = false;

    if (node) {
      await node.update({ ...req.body, last_updated: new Date() });
    } else {
      created = true;
      node = await LocalNodeConfig.create({
        ...req.body,
        status: req.body.status || "ACTIVE",
        current_load_percent: req.body.current_load_percent ?? 0,
        coalition_join_date: req.body.coalition_join_date || new Date(),
        last_updated: new Date(),
      });

      // Politique par défaut
      await PolicyConfig.create({
        node_id: node.node_id,
        min_trust_score_to_help: 0.70,
        max_capacity_share_pct: 70,
        heartbeat_interval_sec: 30,
        auto_offer_enabled: true,
        is_current: true,
      });

      // Capacités de filtrage si fournies
      if (Array.isArray(req.body.capabilities) && req.body.capabilities.length > 0) {
        const cap = req.body.capabilities[0];
        await ScrubbingCapability.create({
          node_id: node.node_id,
          max_capacity_gbps: cap.max_capacity_gbps ?? 0,
          filtering_accuracy: cap.filtering_accuracy ?? 1,
          is_active: cap.is_active !== undefined ? cap.is_active : true,
        });
      }
    }

    logAudit({
      event_type: "SYSTEM_CONFIG_CHANGE",
      severity: "INFO",
      actor: "simulation",
      target: node.node_id,
      description: `[SIM] Local node ${created ? "initialized" : "updated"}: ${node.node_name}`,
    });

    return res.status(created ? 201 : 200).json(node);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /simulation/attack/detect
// Simule le signal ATTACK_DETECTED de la boîte noire de détection
router.post("/simulation/attack/detect", async (req, res) => {
  try {
    const node = await LocalNodeConfig.findOne();
    const localCapacity = Number(node?.max_scrubbing_capacity_gbps || 0);
    const localLoad = Number(node?.current_load_percent || 0);
    const available = Math.max(0, localCapacity * (1 - localLoad / 100));
    const volumeGbps = Number(req.body.volume_gbps || 0);
    const overflow = Math.max(0, volumeGbps - available);

    const attack = await Attack.create({
      detected_at: req.body.timestamp || new Date(),
      status: "DETECTED",
      peak_volume_gbps: volumeGbps,
      local_capacity_at_detection: available,
      overflow_volume_gbps: overflow,
      target_ip_range: req.body.target_ip_range ?? null,
      target_service: req.body.target_service ?? null,
      target_port: req.body.target_port ?? null,
      target_protocol: req.body.target_protocol ?? null,
      severity: req.body.severity || "MEDIUM",
      coalition_helped: false,
    });

    logAudit({
      event_type: "ATTACK_DETECTED",
      severity: "WARNING",
      actor: "simulation",
      target: attack.attack_id,
      description: `[SIM] Attack detected: ${volumeGbps} Gbps`,
    });

    return res.status(201).json({
      message: "Attack detection simulated",
      attack,
      node_state: {
        local_capacity_gbps: localCapacity,
        available_gbps: Number(available.toFixed(2)),
        overflow_gbps: Number(overflow.toFixed(2)),
        escalation_needed: overflow > 0,
      },
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /simulation/attack/end
// Simule le signal ATTACK_ENDED de la boîte noire
router.post("/simulation/attack/end", async (req, res) => {
  try {
    if (!req.body.attack_id) {
      return res.status(400).json({ error: "attack_id is required" });
    }

    const attack = await Attack.findByPk(req.body.attack_id);
    if (!attack) {
      return res.status(404).json({ error: "Attack not found" });
    }

    const now = new Date();
    const duration = req.body.attack_duration_seconds
      ?? Math.floor((now - new Date(attack.detected_at)) / 1000);

    await attack.update({
      ended_at: now,
      duration_seconds: duration,
      status: "ENDED",
    });

    return res.json({
      message: "Attack end simulated",
      attack,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

module.exports = router;
