const express = require("express");
const { Op } = require("sequelize");
const {
  Attack,
  HelpSession,
  LocalNodeConfig,
  Peer,
  PeerCapability,
  ReciprocityLedger,
} = require("../models");
const { logAudit, logMessage } = require("../utils/logger");
const { fetchCrFromNetwork } = require("../utils/trustManager");

const router = express.Router();

/**
 * @swagger
 * /attacks:
 *   get:
 *     tags: [Coalition]
 *     summary: Lister les attaques
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ONGOING, ENDED, MITIGATED] }
 *       - in: query
 *         name: severity
 *         schema: { type: string, enum: [LOW, MEDIUM, HIGH, CRITICAL] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Liste des attaques
 *
 * /attacks/{attack_id}:
 *   get:
 *     tags: [Coalition]
 *     summary: Détail d'une attaque
 *     parameters:
 *       - in: path
 *         name: attack_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Attaque trouvée
 *       404:
 *         description: Attaque introuvable
 *
 * /help/request:
 *   post:
 *     tags: [Coalition]
 *     summary: Demander l'aide d'un pair
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [attack_id, helping_peer_id]
 *             properties:
 *               attack_id: { type: string, format: uuid }
 *               helping_peer_id: { type: string, format: uuid }
 *               allocation_pct: { type: number, description: "Pourcentage du flux attribué à ce pair (0-100)" }
 *     responses:
 *       201:
 *         description: Session créée
 *       400:
 *         description: Données invalides
 *       403:
 *         description: Pair banni ou expulsé
 *
 * /help/offer:
 *   post:
 *     tags: [Coalition]
 *     summary: Proposer de l'aide à un pair
 *     responses:
 *       201:
 *         description: Offre créée
 *
 * /help/{session_id}/accept:
 *   put:
 *     tags: [Coalition]
 *     summary: Accepter une session d'aide
 *     parameters:
 *       - in: path
 *         name: session_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               accepted_volume_gbps: { type: number }
 *     responses:
 *       200:
 *         description: Session acceptée
 *       409:
 *         description: Statut invalide pour cette transition
 *
 * /help/{session_id}/reject:
 *   put:
 *     tags: [Coalition]
 *     summary: Rejeter une session d'aide
 *     parameters:
 *       - in: path
 *         name: session_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Session rejetée
 *       409:
 *         description: Statut invalide pour cette transition
 *
 * /traffic/redirect:
 *   post:
 *     tags: [Coalition]
 *     summary: Rediriger le trafic vers un pair
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [session_id, tunnel_type]
 *             properties:
 *               session_id: { type: string, format: uuid }
 *               tunnel_type: { type: string, enum: [GRE, IPIP, VXLAN] }
 *               volume_gbps: { type: number }
 *     responses:
 *       200:
 *         description: Redirection enregistrée
 *       409:
 *         description: Session pas encore acceptée
 *
 * /attack/over:
 *   post:
 *     tags: [Coalition]
 *     summary: Clôturer une attaque et mettre à jour les crédits
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [attack_id]
 *             properties:
 *               attack_id: { type: string, format: uuid }
 *               session_ids: { type: array, items: { type: string, format: uuid } }
 *               attack_duration_seconds: { type: integer }
 *     responses:
 *       200:
 *         description: Attaque clôturée et crédits mis à jour
 *
 * /sessions/active:
 *   get:
 *     tags: [Coalition]
 *     summary: Lister les sessions actives
 *     responses:
 *       200:
 *         description: Sessions actives
 *
 * /sessions/{session_id}:
 *   get:
 *     tags: [Coalition]
 *     summary: Détail d'une session
 *     parameters:
 *       - in: path
 *         name: session_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Session trouvée
 *       404:
 *         description: Session introuvable
 */

// Échelle Stormwall Network : sévérité calculée à partir du volume total filtré
function computeSeverity(total_volume_gbps) {
  if (total_volume_gbps >= 100) return "CRITICAL";
  if (total_volume_gbps >= 10)  return "HIGH";
  if (total_volume_gbps >= 1)   return "MEDIUM";
  return "LOW";
}

async function getLocalNodeId() {
  const node = await LocalNodeConfig.findOne();
  return node ? node.node_id : null;
}

// POST /alert
router.post("/alert", async (req, res) => {
  try {
    const payload = {
      detected_at: req.body.detected_at || new Date(),
      status: req.body.status || "DETECTED",
      peak_volume_gbps: req.body.volume_gbps ?? req.body.peak_volume_gbps ?? 0,
      local_capacity_at_detection: req.body.local_capacity_at_detection ?? null,
      overflow_volume_gbps: req.body.overflow_volume_gbps ?? 0,
      target_ip_range: req.body.target_ip_range ?? null,
      target_service: req.body.target_service ?? null,
      target_port: req.body.target_port ?? null,
      target_protocol: req.body.target_protocol ?? null,
      severity: "LOW", // calculée a posteriori dans POST /attack/over
      coalition_helped: Boolean(req.body.coalition_helped),
    };

    let attack = null;
    let created = false;

    if (req.body.attack_id) {
      attack = await Attack.findByPk(req.body.attack_id);
    }

    if (attack) {
      await attack.update(payload);
    } else {
      created = true;
      attack = await Attack.create({ attack_id: req.body.attack_id, ...payload });
    }

    return res.status(created ? 201 : 200).json(attack);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// GET /attacks
router.get("/attacks", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 20);
    const offset = Number(req.query.offset || 0);
    const where = {};

    if (req.query.status) where.status = req.query.status;

    if (req.query.severity) where.severity = req.query.severity;

    const { count, rows } = await Attack.findAndCountAll({
      where,
      order: [["detected_at", "DESC"]],
      limit,
      offset,
    });

    return res.json({ total: count, limit, offset, attacks: rows });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /attacks/:id
router.get("/attacks/:id", async (req, res) => {
  try {
    const attack = await Attack.findByPk(req.params.id, {
      include: [
        {
          model: HelpSession,
          as: "help_sessions",
          include: [
            { model: Peer, as: "helping_peer" },
            { model: LocalNodeConfig, as: "requesting_node" },
          ],
        },
      ],
    });

    if (!attack) {
      return res.status(404).json({ error: "Attack not found" });
    }

    return res.json(attack);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /help/request
router.post("/help/request", async (req, res) => {
  try {
    if (!req.body.attack_id || !req.body.helping_peer_id) {
      return res.status(400).json({ error: "attack_id and helping_peer_id are required" });
    }

    const localNodeId = await getLocalNodeId();
    const requestingNodeId = req.body.requesting_node_id || localNodeId;

    if (!requestingNodeId) {
      return res.status(400).json({ error: "Local node configuration is missing" });
    }

    const attack = await Attack.findByPk(req.body.attack_id);
    if (!attack) {
      return res.status(404).json({ error: "Attack not found" });
    }

    const peer = await Peer.findByPk(req.body.helping_peer_id);
    if (!peer) {
      return res.status(404).json({ error: "Peer not found" });
    }
    if (peer.status === "BANNED") {
      return res.status(403).json({ error: "Peer is banned" });
    }
    if (peer.membership_status === "EXPELLED") {
      return res.status(403).json({ error: "Peer has been expelled from the coalition" });
    }

    const session = await HelpSession.create({
      attack_id: req.body.attack_id,
      requesting_node_id: requestingNodeId,
      helping_peer_id: req.body.helping_peer_id,
      direction: req.body.direction || "OUTBOUND_REQUEST",
      status: req.body.status || "REQUESTED",
      allocation_pct: req.body.allocation_pct ?? null,
      accepted_volume_gbps: req.body.accepted_volume_gbps ?? null,
      actual_volume_gbps: req.body.actual_volume_gbps ?? null,
      requested_at: req.body.requested_at || new Date(),
      response_time_ms: req.body.response_time_ms ?? null,
      rejection_reason: req.body.rejection_reason ?? null,
      failure_reason: req.body.failure_reason ?? null,
      tunnel_type: req.body.tunnel_type ?? null,
      credits_exchanged: req.body.credits_exchanged ?? 0,
    });

    logMessage({ message_type: "HELP_REQUEST", direction: "SENT", peer_id: req.body.helping_peer_id, priority: "CRITICAL" });

    return res.status(201).json(session);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /help/offer
router.post("/help/offer", async (req, res) => {
  try {
    if (!req.body.attack_id || !req.body.helping_peer_id) {
      return res.status(400).json({ error: "attack_id and helping_peer_id are required" });
    }

    const localNodeId = await getLocalNodeId();
    const requestingNodeId = req.body.requesting_node_id || localNodeId;

    if (!requestingNodeId) {
      return res.status(400).json({ error: "Local node configuration is missing" });
    }

    const attack = await Attack.findByPk(req.body.attack_id);
    if (!attack) {
      return res.status(404).json({ error: "Attack not found" });
    }

    const peer = await Peer.findByPk(req.body.helping_peer_id);
    if (!peer) {
      return res.status(404).json({ error: "Peer not found" });
    }
    if (peer.status === "BANNED") {
      return res.status(403).json({ error: "Peer is banned" });
    }

    const session = await HelpSession.create({
      attack_id: req.body.attack_id,
      requesting_node_id: requestingNodeId,
      helping_peer_id: req.body.helping_peer_id,
      direction: req.body.direction || "INBOUND_OFFER",
      status: req.body.status || "OFFERED",
      allocation_pct: req.body.allocation_pct ?? null,
      accepted_volume_gbps: req.body.accepted_volume_gbps ?? null,
      actual_volume_gbps: req.body.actual_volume_gbps ?? null,
      requested_at: req.body.requested_at || new Date(),
      response_time_ms: req.body.response_time_ms ?? null,
      tunnel_type: req.body.tunnel_type ?? null,
      credits_exchanged: req.body.credits_exchanged ?? 0,
    });

    logMessage({ message_type: "HELP_OFFER", direction: "RECEIVED", peer_id: req.body.helping_peer_id, priority: "HIGH" });

    return res.status(201).json(session);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// GET /sessions — toutes les sessions (historique complet)
router.get("/sessions", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const sessions = await HelpSession.findAll({
      include: [
        { model: Attack, as: "attack" },
        { model: Peer, as: "helping_peer" },
        { model: LocalNodeConfig, as: "requesting_node" },
      ],
      order: [["created_at", "DESC"]],
      limit,
    });
    return res.json(sessions);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /sessions/active  (doit être AVANT /sessions/:id pour éviter le conflit de route)
router.get("/sessions/active", async (req, res) => {
  const ACTIVE = ["REQUESTED", "OFFERED", "NEGOTIATING", "ACCEPTED", "ACTIVE"];
  try {
    const sessions = await HelpSession.findAll({
      where: { status: { [Op.in]: ACTIVE } },
      include: [
        { model: Attack, as: "attack" },
        { model: Peer, as: "helping_peer" },
        { model: LocalNodeConfig, as: "requesting_node" },
      ],
      order: [["created_at", "DESC"]],
    });
    return res.json(sessions);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /sessions/:id
router.get("/sessions/:id", async (req, res) => {
  try {
    const session = await HelpSession.findByPk(req.params.id, {
      include: [
        { model: Attack, as: "attack" },
        {
          model: Peer,
          as: "helping_peer",
          include: [{ model: PeerCapability, as: "capabilities" }],
        },
      ],
    });

    if (!session) {
      return res.status(404).json({ error: "Help session not found" });
    }

    return res.json(session);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// PUT /help/:id/accept
router.put("/help/:id/accept", async (req, res) => {
  try {
    const session = await HelpSession.findByPk(req.params.id);

    if (!session) {
      return res.status(404).json({ error: "Help session not found" });
    }

    const acceptableStatuses = ["REQUESTED", "OFFERED", "NEGOTIATING"];
    if (!acceptableStatuses.includes(session.status)) {
      return res.status(409).json({ error: `Cannot accept a session in status: ${session.status}` });
    }

    await session.update({
      status: "ACCEPTED",
      accepted_volume_gbps: req.body.accepted_volume_gbps ?? session.accepted_volume_gbps,
      responded_at: req.body.responded_at || new Date(),
      tunnel_type: req.body.tunnel_type ?? session.tunnel_type,
      response_time_ms: req.body.response_time_ms ?? session.response_time_ms,
      updated_at: new Date(),
    });

    logMessage({ message_type: "HELP_ACCEPT", direction: "SENT", peer_id: session.helping_peer_id, priority: "HIGH" });

    return res.json(session);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// PUT /help/:id/reject
router.put("/help/:id/reject", async (req, res) => {
  try {
    const session = await HelpSession.findByPk(req.params.id);

    if (!session) {
      return res.status(404).json({ error: "Help session not found" });
    }

    const rejectableStatuses = ["REQUESTED", "OFFERED", "NEGOTIATING"];
    if (!rejectableStatuses.includes(session.status)) {
      return res.status(409).json({ error: `Cannot reject a session in status: ${session.status}` });
    }

    await session.update({
      status: "REJECTED",
      rejection_reason: req.body.rejection_reason || "Rejected by peer",
      responded_at: req.body.responded_at || new Date(),
      updated_at: new Date(),
    });

    logMessage({ message_type: "HELP_REJECT", direction: "SENT", peer_id: session.helping_peer_id, priority: "NORMAL" });

    return res.json(session);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /traffic/redirect
router.post("/traffic/redirect", async (req, res) => {
  try {
    const sessionId = req.body.session_id || req.body.id;
    const session = await HelpSession.findByPk(sessionId);

    if (!session) {
      return res.status(404).json({ error: "Help session not found" });
    }

    if (session.status !== "ACCEPTED") {
      return res.status(409).json({ error: `Cannot redirect traffic for a session in status: ${session.status}` });
    }

    await session.update({
      status: "ACTIVE",
      tunnel_type: req.body.tunnel_type ?? session.tunnel_type,
      actual_volume_gbps: req.body.volume_gbps ?? req.body.actual_volume_gbps ?? session.actual_volume_gbps,
      activated_at: req.body.activated_at || new Date(),
      updated_at: new Date(),
    });

    logMessage({ message_type: "TRAFFIC_REDIRECT", direction: "SENT", peer_id: session.helping_peer_id, priority: "CRITICAL" });

    return res.json(session);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /attack/over
router.post("/attack/over", async (req, res) => {
  try {
    const attack = await Attack.findByPk(req.body.attack_id);

    if (!attack) {
      return res.status(404).json({ error: "Attack not found" });
    }

    const sessionIds = Array.isArray(req.body.session_ids) ? req.body.session_ids : [];

    if (sessionIds.length > 0) {
      const sessions = await HelpSession.findAll({
        where: { session_id: { [Op.in]: sessionIds } },
      });

      await HelpSession.update(
        {
          status: "COMPLETED",
          completed_at: req.body.timestamp || new Date(),
          updated_at: new Date(),
        },
        { where: { session_id: { [Op.in]: sessionIds } } },
      );

      // Capturer Cr au moment de la clôture, une seule fois par pair distinct
      const localNodeId = await getLocalNodeId();
      const crCache = {};

      for (const session of sessions) {
        // Si actual_volume_gbps n'a pas été renseigné, on utilise le volume accepté
        // (le pair a fourni ce qu'il avait promis)
        if (!session.actual_volume_gbps) {
          await session.update({
            actual_volume_gbps: session.accepted_volume_gbps ?? 0,
          });
        }

        // Sauvegarder Cr historique : opinion du réseau sur le nœud local au moment de la session
        if (localNodeId) {
          const pid = session.helping_peer_id;
          if (crCache[pid] === undefined) {
            crCache[pid] = await fetchCrFromNetwork(localNodeId, pid);
          }
          await session.update({ cr_value: crCache[pid] });
        }

        const volume = session.actual_volume_gbps || session.accepted_volume_gbps || 0;

        await session.update({ credits_exchanged: volume });

        const [ledger] = await ReciprocityLedger.findOrCreate({
          where: { peer_id: session.helping_peer_id },
          defaults: { peer_id: session.helping_peer_id, credits_received: 0, credits_given: 0, balance: 0 },
        });
        await ledger.update({
          credits_given: ledger.credits_given + volume,
          balance: ledger.balance + volume,
          last_transaction_at: new Date(),
          updated_at: new Date(),
        });
      }
    }

    // Volume total filtré = somme des actual_volume_gbps de toutes les sessions
    const allSessions = await HelpSession.findAll({
      where: { attack_id: req.body.attack_id, status: "COMPLETED" },
    });
    const totalFiltered = allSessions.reduce(
      (sum, s) => sum + Number(s.actual_volume_gbps ?? 0), 0
    );

    await attack.update({
      ended_at: req.body.timestamp || new Date(),
      duration_seconds: req.body.attack_duration_seconds ?? attack.duration_seconds,
      status: req.body.status || "ENDED",
      coalition_helped: sessionIds.length > 0 ? true : attack.coalition_helped,
      nb_peers_involved: sessionIds.length || attack.nb_peers_involved,
      severity: computeSeverity(totalFiltered),
    });

    return res.json(attack);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

module.exports = router;
