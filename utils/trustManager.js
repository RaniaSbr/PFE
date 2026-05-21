/**
 * Gestionnaire de Confiance — modèle PeerTrust (Xiong & Liu, 2004, Éq. 6)
 *
 * Formule originale (Éq. 6) :
 *   T(u) = Σ_{i=1}^{I(u)} S(u,i) · Cr(p(u,i)) · D(u,i)
 *
 *   S(u,i)        = min(1, actual_gbps / accepted_gbps)   — satisfaction normalisée
 *   Cr(p(u,i))    = T(requesting_peer)  ou 0.5 si inconnu — crédibilité de l'évaluateur
 *   D(u,i)        = severity_weight (LOW→0.25 … CRITICAL→1.0) — contexte transactionnel
 *
 * Niveaux : GOLD ≥ 0.80 | SILVER ≥ 0.60 | BRONZE ≥ 0.40 | SUSPECT ≥ 0.20 | BANNED < 0.20
 */

const { HelpSession, Attack, TrustScore, Peer, LocalNodeConfig } = require("../models");
const { logAudit } = require("./logger");
const httpsClient  = require("./httpsClient");
const { generateToken } = require("../middleware/auth");

// Facteur contextuel D(u,i) selon la sévérité de l'attaque (Éq. 6)
const SEVERITY_WEIGHTS = {
  LOW: 0.25,
  MEDIUM: 0.50,
  HIGH: 0.75,
  CRITICAL: 1.00,
};

// Score initial par défaut pour un pair sans historique (cold start)
const DEFAULT_TRUST = 0.5;

// Seuils de niveaux de confiance (doc §B.1 éq. 8)
function scoreToLevel(score) {
  if (score >= 0.80) return "GOLD";
  if (score >= 0.60) return "SILVER";
  if (score >= 0.40) return "BRONZE";
  if (score >= 0.20) return "SUSPECT";
  return "BANNED";
}

/**
 * Récupère le score de confiance stocké d'un pair (last known value).
 * Retourne DEFAULT_TRUST si aucun score n'existe encore (cold start).
 */
async function getCachedTrust(peer_id) {
  if (!peer_id) return DEFAULT_TRUST;
  const ts = await TrustScore.findOne({ where: { peer_id }, attributes: ["overall_score"] });
  return ts ? Number(ts.overall_score) : DEFAULT_TRUST;
}

/**
 * Interroge un pair via son API REST pour obtenir ce qu'il pense du nœud local.
 * Retourne DEFAULT_TRUST si le pair est injoignable.
 */
async function fetchCrFromPeer(peer, localNodeId) {
  try {
    const token = generateToken(localNodeId);
    const url   = `${peer.api_endpoint_url.replace(/\/$/, "")}/trust/${localNodeId}`;
    const resp  = await httpsClient.get(url, { token, timeout: 3000 });

    if (resp.status === 200) {
      const score = resp.data?.peer?.trust_score?.overall_score;
      if (score !== undefined && score !== null) return Number(score);
    }
    return DEFAULT_TRUST;
  } catch {
    return DEFAULT_TRUST;
  }
}

/**
 * Mécanisme PeerTrust : interroge TOUS les pairs actifs (sauf le pair évalué)
 * pour obtenir leur opinion sur le nœud local → Cr(p) = moyenne des T(nœud_local).
 *
 * University interroge PME et Datacenter : "Quel est votre T(University) ?"
 * Cr = moyenne des réponses reçues.
 * Si aucun pair ne répond → DEFAULT_TRUST (0.5).
 */
async function fetchCrFromNetwork(localNodeId, excludePeerId) {
  const { Op } = require("sequelize");

  const peers = await Peer.findAll({
    where: {
      status: ["ACTIVE", "INACTIVE"],
      peer_id: { [Op.ne]: excludePeerId },
    },
    attributes: ["peer_id", "api_endpoint_url"],
  });

  if (peers.length === 0) return DEFAULT_TRUST;

  const results = await Promise.allSettled(
    peers.map((peer) => fetchCrFromPeer(peer, localNodeId))
  );

  const scores = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);

  if (scores.length === 0) return DEFAULT_TRUST;

  // Moyenne simple des opinions reçues du réseau
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/**
 * Calcule T(u) pour un pair donné selon PeerTrust Éq. 6 (Xiong & Liu, 2004).
 *
 * T(u) = Σ[ S(u,i) · Cr(u,i) · D(u,i) ] / Σ[ Cr(u,i) · D(u,i) ]
 *
 * Cr(u,i) est capturé à la clôture de chaque session (cr_value en base).
 * Chaque session conserve ainsi la crédibilité du réseau au moment des faits.
 * Retourne { score, level, session_count }.
 */
async function computeTrustScore(peer_id) {
  const sessions = await HelpSession.findAll({
    where: { helping_peer_id: peer_id, status: "COMPLETED" },
    include: [{ model: Attack, as: "attack", attributes: ["severity"] }],
  });

  if (sessions.length === 0) {
    return { score: DEFAULT_TRUST, level: "BRONZE", session_count: 0 };
  }

  // T(u) = Σ[S·Cr_i·D] / Σ[Cr_i·D]
  // Cr_i = cr_value sauvegardé à la clôture de la session i.
  // Chaque session ayant potentiellement un Cr différent, Cr ne s'annule plus.
  // Normalisation inspirée de l'Éq. 3 (Xiong & Liu, 2004) → T(u) ∈ [0,1].
  let numerator   = 0;
  let denominator = 0;

  for (const session of sessions) {
    const accepted = Number(session.accepted_volume_gbps ?? 0);
    const actual   = Number(session.actual_volume_gbps   ?? 0);

    // S(u,i) = min(1, V_réel / V_accepté)
    const S = accepted > 0 ? Math.min(1, actual / accepted) : 0;

    // D(u,i) = facteur contextuel selon la sévérité
    const severity = session.attack?.severity ?? "LOW";
    const D = SEVERITY_WEIGHTS[severity] ?? 0.25;

    // Cr historique capturé à la clôture de la session
    const Cr_i = session.cr_value ?? DEFAULT_TRUST;

    numerator   += S * Cr_i * D;
    denominator += Cr_i * D;
  }

  const score = denominator > 0 ? numerator / denominator : DEFAULT_TRUST;
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

module.exports = { computeTrustScore, recalculateAndSave, scoreToLevel, getCachedTrust, fetchCrFromNetwork };
