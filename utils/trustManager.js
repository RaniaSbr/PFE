/**
 * Gestionnaire de Confiance — modèle PeerTrust
 *
 * Formule : T(p) = Σ(Sk * Crk * Wk) / Σ(Crk * Wk)
 *   Sk  = min(1, actual_volume / accepted_volume)   — satisfaction de la session
 *   Crk = T(source)  ou 0.5 si inconnu             — crédibilité de la source
 *   Wk  = poids contextuel selon la sévérité de l'attaque
 *
 * Niveaux : GOLD ≥ 0.80 | SILVER ≥ 0.60 | BRONZE ≥ 0.40 | SUSPECT ≥ 0.20 | BANNED < 0.20
 */

const { HelpSession, Attack, TrustScore, Peer } = require("../models");
const { logAudit } = require("./logger");

// Poids contextuel selon la sévérité de l'attaque (doc §B.1 éq. 6)
const SEVERITY_WEIGHTS = {
  LOW: 0.25,
  MEDIUM: 0.50,
  HIGH: 0.75,
  CRITICAL: 1.00,
};

// Seuils de niveaux de confiance (doc §B.1 éq. 8)
function scoreToLevel(score) {
  if (score >= 0.80) return "GOLD";
  if (score >= 0.60) return "SILVER";
  if (score >= 0.40) return "BRONZE";
  if (score >= 0.20) return "SUSPECT";
  return "BANNED";
}

/**
 * Calcule T(p) pour un pair donné à partir des sessions COMPLETED où ce pair a aidé.
 * Retourne { score, level, session_count }.
 */
async function computeTrustScore(peer_id) {
  // Sessions complètes où le pair a joué le rôle d'aidant
  const sessions = await HelpSession.findAll({
    where: {
      helping_peer_id: peer_id,
      status: "COMPLETED",
    },
    include: [
      {
        model: Attack,
        as: "attack",
        attributes: ["severity"],
      },
    ],
  });

  if (sessions.length === 0) {
    // Initialisation : T(p) = 0.5 (doc §B.1 éq. 7)
    return { score: 0.5, level: "BRONZE", session_count: 0 };
  }

  let numerator = 0;
  let denominator = 0;

  for (const session of sessions) {
    const accepted = Number(session.accepted_volume_gbps ?? 0);
    const actual = Number(session.actual_volume_gbps ?? 0);

    // Sk = min(1, V_réel / V_acc) — si V_acc = 0, Sk = 0
    const Sk = accepted > 0 ? Math.min(1, actual / accepted) : 0;

    // Crk = 0.5 par défaut (nœud local sans score externe connu)
    const Crk = 0.5;

    // Wk selon la sévérité de l'attaque associée
    const severity = session.attack?.severity ?? "LOW";
    const Wk = SEVERITY_WEIGHTS[severity] ?? 0.25;

    numerator += Sk * Crk * Wk;
    denominator += Crk * Wk;
  }

  const score = denominator > 0 ? Math.min(1, Math.max(0, numerator / denominator)) : 0.5;
  const level = scoreToLevel(score);

  return { score, level, session_count: sessions.length };
}

/**
 * Recalcule le score de confiance d'un pair et le persiste dans TRUST_SCORES.
 * Met à jour le statut du pair si BANNED.
 * Retourne le TrustScore mis à jour.
 */
async function recalculateAndSave(peer_id) {
  const { score, level, session_count } = await computeTrustScore(peer_id);

  const [trustScore, created] = await TrustScore.findOrCreate({
    where: { peer_id },
    defaults: {
      peer_id,
      overall_score: score,
      trust_level: level,
      last_calculated: new Date(),
    },
  });

  if (!created) {
    const previousLevel = trustScore.trust_level;

    await trustScore.update({
      overall_score: score,
      trust_level: level,
      last_calculated: new Date(),
    });

    if (previousLevel !== level) {
      logAudit({
        event_type: "TRUST_LEVEL_CHANGED",
        severity: level === "BANNED" || level === "SUSPECT" ? "WARNING" : "INFO",
        actor: "trust_manager",
        target: peer_id,
        description: `Trust level changed: ${previousLevel} → ${level} (score=${score.toFixed(3)}, sessions=${session_count})`,
      });
    }
  }

  // Appliquer automatiquement la sanction si le score tombe en BANNED
  if (level === "BANNED") {
    const peer = await Peer.findByPk(peer_id);
    if (peer && peer.status !== "BANNED") {
      await peer.update({ status: "BANNED", membership_status: "EXPELLED", updated_at: new Date() });

      logAudit({
        event_type: "PEER_BANNED",
        severity: "CRITICAL",
        actor: "trust_manager",
        target: peer_id,
        description: `Peer auto-banned by trust manager (score=${score.toFixed(3)})`,
      });
    }
  }

  return { ...trustScore.toJSON(), overall_score: score, trust_level: level };
}

module.exports = { computeTrustScore, recalculateAndSave, scoreToLevel };
