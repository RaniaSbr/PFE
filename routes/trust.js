const express = require("express");
const {
  Peer,
  ReciprocityLedger,
  TrustScore,
  TrustViolation,
} = require("../models");
const { logAudit } = require("../utils/logger");
const { recalculateAndSave } = require("../utils/trustManager");
const { selectPeers } = require("../utils/peerSelector");

const router = express.Router();

/**
 * @swagger
 * /trust:
 *   get:
 *     tags: [Trust]
 *     summary: Lister les scores de confiance
 *     parameters:
 *       - in: query
 *         name: trust_level
 *         schema: { type: string, enum: [GOLD, SILVER, BRONZE, SUSPECT, BANNED] }
 *     responses:
 *       200:
 *         description: Liste des scores
 *
 * /trust/{peer_id}:
 *   get:
 *     tags: [Trust]
 *     summary: Score de confiance et ledger d'un pair
 *     parameters:
 *       - in: path
 *         name: peer_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Score et violations récentes
 *       404:
 *         description: Pair introuvable
 *
 * /trust/{peer_id}/recalculate:
 *   post:
 *     tags: [Trust]
 *     summary: Recalculer le score de confiance d'un pair (formule PeerTrust)
 *     parameters:
 *       - in: path
 *         name: peer_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Score recalculé et persisté
 *       404:
 *         description: Pair introuvable
 *
 * /trust/select-peers:
 *   post:
 *     tags: [Trust]
 *     summary: Sélectionner les pairs pour absorber un volume excédentaire (WSM)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [overflow_gbps]
 *             properties:
 *               overflow_gbps: { type: number, description: "Volume excédentaire à redistribuer (Gbps)" }
 *               min_trust_score: { type: number, description: "Score minimum (défaut : 0.0)" }
 *               ignore_trust: { type: boolean, description: "Ignorer le filtre de confiance (mode CRITIQUE)" }
 *     responses:
 *       200:
 *         description: Plan d'allocation retourné
 *
 * /trust/{peer_id}/violation:
 *   post:
 *     tags: [Trust]
 *     summary: Enregistrer une violation de confiance
 *     parameters:
 *       - in: path
 *         name: peer_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [violation_type, severity, description, sanction_applied]
 *             properties:
 *               violation_type: { type: string }
 *               severity: { type: string, enum: [LOW, MEDIUM, HIGH, CRITICAL] }
 *               description: { type: string }
 *               sanction_applied: { type: string, enum: [WARNING, TEMP_SUSPENSION, PERMANENT_BAN] }
 *               sanction_until: { type: string, format: date-time }
 *     responses:
 *       201:
 *         description: Violation enregistrée et sanction appliquée
 */

// GET /trust
router.get("/trust", async (req, res) => {
  try {
    const where = {};
    if (req.query.trust_level) where.trust_level = req.query.trust_level;

    const scores = await TrustScore.findAll({
      where,
      include: [
        {
          model: Peer,
          as: "peer",
          attributes: ["peer_id", "peer_name", "organization_name", "tier", "status"],
        },
      ],
      order: [["overall_score", "DESC"]],
    });

    return res.json(scores);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// GET /trust/:peer_id
router.get("/trust/:peer_id", async (req, res) => {
  try {
    const peer = await Peer.findByPk(req.params.peer_id, {
      include: [
        { model: TrustScore, as: "trust_score" },
        { model: ReciprocityLedger, as: "reciprocity_ledger" },
      ],
    });

    if (!peer) {
      return res.status(404).json({ error: "Peer not found" });
    }

    const recentViolations = await TrustViolation.findAll({
      where: { peer_id: peer.peer_id },
      order: [["detected_at", "DESC"]],
      limit: 10,
    });

    return res.json({ peer, recent_violations: recentViolations });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /trust/:peer_id/violation
router.post("/trust/:peer_id/violation", async (req, res) => {
  try {
    const { peer_id } = req.params;
    const { violation_type, severity, description, sanction_applied, sanction_until } = req.body;

    if (!violation_type || !severity || !description || !sanction_applied) {
      return res.status(400).json({
        error: "violation_type, severity, description and sanction_applied are required",
      });
    }

    const peer = await Peer.findByPk(peer_id);
    if (!peer) {
      return res.status(404).json({ error: "Peer not found" });
    }

    const violation = await TrustViolation.create({
      peer_id,
      violation_type,
      severity,
      description,
      sanction_applied,
      sanction_until: sanction_until ?? null,
    });

    // Appliquer la sanction au statut du pair
    const peerUpdates = {};
    if (sanction_applied === "PERMANENT_BAN") {
      peerUpdates.status = "BANNED";
      peerUpdates.membership_status = "EXPELLED";
    } else if (sanction_applied === "TEMP_SUSPENSION") {
      peerUpdates.status = "SUSPECTED";
      peerUpdates.membership_status = "SUSPENDED";
    }

    if (Object.keys(peerUpdates).length > 0) {
      await peer.update({ ...peerUpdates, updated_at: new Date() });
    }

    const auditEventType = sanction_applied === "PERMANENT_BAN" ? "PEER_BANNED" : "TRUST_LEVEL_CHANGED";
    logAudit({
      event_type: auditEventType,
      severity: sanction_applied === "PERMANENT_BAN" ? "CRITICAL" : "WARNING",
      actor: "system",
      target: peer_id,
      description: `Violation: ${violation_type} — Sanction: ${sanction_applied} — ${description}`,
    });

    return res.status(201).json({ violation, peer });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /trust/:peer_id/recalculate
router.post("/trust/:peer_id/recalculate", async (req, res) => {
  try {
    const peer = await Peer.findByPk(req.params.peer_id);
    if (!peer) {
      return res.status(404).json({ error: "Peer not found" });
    }

    const result = await recalculateAndSave(req.params.peer_id);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /trust/select-peers
router.post("/trust/select-peers", async (req, res) => {
  try {
    const { overflow_gbps, min_trust_score, ignore_trust } = req.body;

    if (overflow_gbps === undefined || overflow_gbps <= 0) {
      return res.status(400).json({ error: "overflow_gbps must be a positive number" });
    }

    const result = await selectPeers(overflow_gbps, {
      minTrustScore: min_trust_score ?? 0.0,
      ignoreTrust: ignore_trust ?? false,
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
