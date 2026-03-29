const express = require("express");
const {
  Attack,
  LocalNodeConfig,
  PolicyConfig,
  ScrubbingCapability,
} = require("../models");
const { logAudit } = require("../utils/logger");

const router = express.Router();

// GET /simulation/ping
router.get("/simulation/ping", (req, res) => {
  res.json({
    message: "Simulation routes are ready",
    timestamp: new Date().toISOString(),
  });
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
        alert_threshold_pct: 70,
        escalation_threshold_pct: 85,
        critical_threshold_pct: 95,
        min_trust_score_to_help: 0.70,
        max_capacity_share_pct: 70,
        heartbeat_interval_sec: 30,
        auto_offer_enabled: true,
        is_current: true,
      });

      // Capacités de filtrage si fournies
      if (Array.isArray(req.body.capabilities)) {
        for (const cap of req.body.capabilities) {
          if (!cap.attack_type_supported) continue;
          await ScrubbingCapability.create({
            node_id: node.node_id,
            attack_type_supported: cap.attack_type_supported,
            max_capacity_gbps: cap.max_capacity_gbps ?? 0,
            filtering_accuracy: cap.filtering_accuracy ?? 1,
            is_active: cap.is_active !== undefined ? cap.is_active : true,
          });
        }
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
    if (!req.body.attack_type) {
      return res.status(400).json({ error: "attack_type is required" });
    }

    const node = await LocalNodeConfig.findOne();
    const localCapacity = Number(node?.max_scrubbing_capacity_gbps || 0);
    const localLoad = Number(node?.current_load_percent || 0);
    const available = Math.max(0, localCapacity * (1 - localLoad / 100));
    const volumeGbps = Number(req.body.volume_gbps || 0);
    const overflow = Math.max(0, volumeGbps - available);

    const attack = await Attack.create({
      attack_type: req.body.attack_type,
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
      escalation_triggered: false,
      coalition_helped: false,
    });

    logAudit({
      event_type: "ESCALATION_TRIGGERED",
      severity: "WARNING",
      actor: "simulation",
      target: attack.attack_id,
      description: `[SIM] Attack detected: ${attack.attack_type} — ${volumeGbps} Gbps`,
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
