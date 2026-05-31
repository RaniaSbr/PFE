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
const { recalculateAndSave } = require("../utils/trustManager");

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

    // Le volume n'est pas connu à la détection — seule la congestion est observable.
    // actual_volume_gbps sera renseigné par les pairs à la fin de la mitigation.
    const peakVolume = Number(req.body.volume_gbps || 0);
    const overflow   = Math.max(0, peakVolume - available);
    const attack = await Attack.create({
      detected_at: req.body.timestamp || new Date(),
      status: "DETECTED",
      peak_volume_gbps:            peakVolume,
      local_capacity_at_detection: available,
      overflow_volume_gbps:        overflow,
      target_ip_range:   req.body.target_ip_range   ?? null,
      target_service:    req.body.target_service    ?? null,
      target_port:       req.body.target_port       ?? null,
      target_protocol:   req.body.target_protocol   ?? null,
      severity:          req.body.severity           || "LOW",
      coalition_helped: false,
    });

    logAudit({
      event_type: "ATTACK_DETECTED",
      severity: "WARNING",
      actor: "simulation",
      target: attack.attack_id,
      description: `[SIM] Anomalie détectée sur ${req.body.target_ip_range || "?"} — volume inconnu`,
    });

    return res.status(201).json({
      message: "Attack detection simulated",
      attack,
      node_state: {
        local_capacity_gbps: localCapacity,
        available_gbps: Number(available.toFixed(2)),
        // Capacité disponible que la coalition peut absorber
        coalition_needed_gbps: Number(available.toFixed(2)),
        escalation_needed: true, // on demande toujours de l'aide — volume inconnu
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

// POST /simulation/seed-peers
// Injecte N pairs virtuels avec des scores de confiance variés pour la démo.
// Chaque profil (GOLD→BANNED) est ingénié via des sessions COMPLETED dont les
// ratios actual/accepted produisent le score voulu selon la formule PeerTrust Éq.6.
router.post("/simulation/seed-peers", async (req, res) => {
  try {
    const node = await LocalNodeConfig.findOne();
    if (!node) {
      return res.status(400).json({ error: "Nœud local non initialisé — lance d'abord init-coalition.py" });
    }

    // Supprimer les pairs virtuels existants (peer_name commence par "sim-")
    const { Op } = require("sequelize");
    const existing = await Peer.findAll({ where: { peer_name: { [Op.like]: "sim-%" } } });
    if (existing.length > 0) {
      const ids = existing.map(p => p.peer_id);
      await HelpSession.destroy({ where: { helping_peer_id: { [Op.in]: ids } } });
      await TrustViolation.destroy({ where: { peer_id: { [Op.in]: ids } } });
      await TrustScore.destroy({ where: { peer_id: { [Op.in]: ids } } });
      await Peer.destroy({ where: { peer_id: { [Op.in]: ids } } });
    }

    // Une attaque fictive partagée par toutes les sessions
    const fakeAttack = await Attack.create({
      detected_at: new Date(Date.now() - 3600_000),
      ended_at:    new Date(Date.now() - 1800_000),
      status: "ENDED",
      severity: "HIGH",
      peak_volume_gbps: 25,
      overflow_volume_gbps: 12,
      local_capacity_at_detection: 10,
      duration_seconds: 1800,
      coalition_helped: true,
      target_ip_range: "10.0.0.0/24",
    });

    // Profils : chaque entrée définit les sessions qui produisent le score voulu.
    // T(u) = Σ[S·D] / Σ[D]  (Cr=0.5 constant, s'annule)
    // S = actual_gbps / accepted_gbps    D = poids de sévérité (LOW=0.25 … CRITICAL=1.0)
    const SEVERITY_D = { LOW: 0.25, MEDIUM: 0.50, HIGH: 0.75, CRITICAL: 1.00 };
    const ORG_TYPES  = ["UNIVERSITY","ISP","DATACENTER","PME","GOVERNMENT","STARTUP","NGO","OTHER"];
    const CAPS       = [5, 10, 15, 20];
    const TUNNELS    = ["GRE","VXLAN","IPSEC","BGP_FLOWSPEC"];

    const PROFILES = [
      {
        level: "GOLD", count: 20,
        // S élevés → T ≈ 0.88–0.95
        sessions: [
          { S: 0.95, sev: "HIGH"     },
          { S: 0.90, sev: "CRITICAL" },
          { S: 0.92, sev: "HIGH"     },
          { S: 0.88, sev: "MEDIUM"   },
        ],
      },
      {
        level: "SILVER", count: 25,
        // S moyens-hauts → T ≈ 0.65–0.75
        sessions: [
          { S: 0.75, sev: "HIGH"     },
          { S: 0.68, sev: "CRITICAL" },
          { S: 0.72, sev: "MEDIUM"   },
          { S: 0.65, sev: "HIGH"     },
        ],
      },
      {
        level: "BRONZE", count: 25,
        // S mixtes → T ≈ 0.45–0.55
        sessions: [
          { S: 0.55, sev: "MEDIUM" },
          { S: 0.48, sev: "HIGH"   },
          { S: 0.52, sev: "LOW"    },
          { S: 0.45, sev: "MEDIUM" },
        ],
      },
      {
        level: "SUSPECT", count: 20,
        // S faibles → T ≈ 0.25–0.32
        sessions: [
          { S: 0.25, sev: "HIGH"     },
          { S: 0.30, sev: "CRITICAL" },
          { S: 0.22, sev: "HIGH"     },
          { S: 0.35, sev: "MEDIUM"   },
        ],
      },
      {
        level: "BANNED", count: 10,
        // S très faibles → T ≈ 0.06–0.10
        sessions: [
          { S: 0.08, sev: "CRITICAL" },
          { S: 0.05, sev: "HIGH"     },
          { S: 0.10, sev: "CRITICAL" },
          { S: 0.07, sev: "HIGH"     },
        ],
      },
    ];

    const summary = [];
    let idx = 1;

    for (const profile of PROFILES) {
      for (let i = 0; i < profile.count; i++, idx++) {
        const orgType = ORG_TYPES[(idx - 1) % ORG_TYPES.length];
        const cap     = CAPS[(idx - 1) % CAPS.length];

        // Légère variation de S pour que chaque pair ait un score distinct
        const jitter = (Math.random() - 0.5) * 0.04;

        const peer = await Peer.create({
          peer_name:                  `sim-${String(idx).padStart(3,"0")}`,
          organization_name:          `${orgType} Sim-${idx}`,
          organization_type:          orgType,
          country_code:               "DZ",
          api_endpoint_url:           `https://sim-${idx}.shieldnet.local/api/v1`,
          public_key:                 `SIMKEY_${idx}`,
          max_scrubbing_capacity_gbps: cap,
          declared_available_gbps:    cap * 0.8,
          status:                     profile.level === "BANNED" ? "BANNED" : "ACTIVE",
          membership_status:          profile.level === "BANNED" ? "EXPELLED" : "CONFIRMED",
          relationship_type:          "KNOWN_PEER",
        });

        // Créer les sessions COMPLETED avec les S ingéniérés
        for (const tpl of profile.sessions) {
          const S_final  = Math.min(1, Math.max(0.01, tpl.S + jitter));
          const accepted = parseFloat((cap * 0.6).toFixed(2));
          const actual   = parseFloat((accepted * S_final).toFixed(2));
          await HelpSession.create({
            attack_id:            fakeAttack.attack_id,
            requesting_node_id:   node.node_id,
            helping_peer_id:      peer.peer_id,
            direction:            "INBOUND_REQUEST",
            status:               "COMPLETED",
            accepted_volume_gbps: accepted,
            actual_volume_gbps:   actual,
            tunnel_type:          TUNNELS[idx % TUNNELS.length],
            cr_value:             0.5,
            credits_exchanged:    parseFloat((actual * 0.1).toFixed(3)),
            allocation_pct:       60,
            requested_at:         new Date(Date.now() - 7200_000),
            responded_at:         new Date(Date.now() - 7100_000),
            activated_at:         new Date(Date.now() - 7000_000),
            completed_at:         new Date(Date.now() - 5400_000),
          });
        }

        // Recalculer et persister le score PeerTrust
        const ts = await recalculateAndSave(peer.peer_id);

        // Violation pour les pairs bannis
        if (profile.level === "BANNED") {
          await TrustViolation.create({
            peer_id:          peer.peer_id,
            violation_type:   "FREE_RIDING",
            severity:         "CRITICAL",
            description:      `[SIM] Pair ${peer.peer_name} — refus répété d'aider lors d'attaques CRITICAL`,
            sanction_applied: "PERMANENT_BAN",
          });
        }

        summary.push({ peer: peer.peer_name, level: ts.trust_level, score: ts.overall_score });
      }
    }

    const counts = summary.reduce((acc, p) => {
      acc[p.level] = (acc[p.level] || 0) + 1;
      return acc;
    }, {});

    logAudit({
      event_type: "SYSTEM_CONFIG_CHANGE",
      severity: "INFO",
      actor: "simulation",
      target: "seed-peers",
      description: `[SIM] ${summary.length} pairs virtuels créés — ${JSON.stringify(counts)}`,
    });

    return res.status(201).json({
      message: `${summary.length} pairs virtuels créés`,
      distribution: counts,
      peers: summary,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
