const express = require("express");
const {
  Peer,
  ReciprocityLedger,
  TrustScore,
  TrustViolation,
} = require("../models");
const { logAudit } = require("../utils/logger");

const router = express.Router();

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

module.exports = router;
