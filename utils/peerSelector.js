/**
 * Algorithme de Sélection des Pairs — modèle WSM (Weighted Sum Model)
 *
 * Score(p) = 0.52·Cp + 0.20·Lp' + 0.20·Tp + 0.08·Rp
 *
 *   Cp  = cap_disp / max(cap_disp)               — capacité disponible normalisée
 *   Lp' = 1 - (Lp - Lmin) / (Lmax - Lmin)       — latence normalisée inversée
 *   Tp  = overall_score issu de TRUST_SCORES      — score de confiance
 *   Rp  = credits_received / (credits_received + credits_given + ε)  — réciprocité bilatérale
 *
 * Répartition proportionnelle :
 *   w_i          = Score(p_i) / Σ Score(p_j)     — poids normalisé du pair i
 *   allocation%(p_i) = w_i × 100                 — pourcentage de flux attribué
 *
 * Tous les pairs éligibles participent. Le flux total à redistribuer
 * est inconnu a priori — la répartition est exprimée en pourcentages.
 *
 * Poids AHP validés (CR = 1.6 % < 10 %) :
 *   wC = 0.52 | wL = 0.20 | wT = 0.20 | wR = 0.08
 */

const { Op } = require("sequelize");
const { Peer, TrustScore, ReciprocityLedger, PolicyConfig, LocalNodeConfig } = require("../models");

const W = { C: 0.52, L: 0.20, T: 0.20, R: 0.08 };
const EPSILON = 1e-6;

/**
 * Calcule le score WSM d'un pair à partir des données normalisées.
 */
function computeScore({ Cp, Lp_inv, Tp, Rp }) {
  return W.C * Cp + W.L * Lp_inv + W.T * Tp + W.R * Rp;
}

/**
 * Sélectionne TOUS les pairs éligibles et calcule la répartition proportionnelle du flux.
 *
 * Le flux total n'est pas requis en entrée : chaque pair reçoit un pourcentage
 * proportionnel à son score WSM. Si le volume est connu, il peut être passé
 * via options.overflowGbps pour calculer les Gbps estimés en supplément.
 *
 * @param {object} options
 * @param {number} [options.overflowGbps]    - Volume excédentaire (optionnel, pour estimation Gbps)
 * @param {number} [options.minTrustScore]   - Score minimum pour participer (défaut : 0.0)
 * @param {boolean} [options.ignoreTrust]    - Ignorer le filtre de confiance
 * @returns {Promise<{ plan: Array, total_peers: number }>}
 *   plan : [{ peer, allocation_pct, weight, score, estimated_gbps?, criteria }]
 */
async function selectPeers({ overflowGbps, minTrustScore = 0.0, ignoreTrust = false } = {}) {
  const node = await LocalNodeConfig.findOne();
  const policy = node
    ? await PolicyConfig.findOne({
        where: { node_id: node.node_id, is_current: true },
        order: [["created_at", "DESC"]],
      })
    : null;

  const minTrust = ignoreTrust ? 0.0 : minTrustScore;

  // Pairs éligibles : ACTIVE, avec capacité disponible
  const peers = await Peer.findAll({
    where: {
      status: { [Op.in]: ["ACTIVE"] },
      declared_available_gbps: { [Op.gt]: 0 },
    },
    include: [
      { model: TrustScore, as: "trust_score" },
      { model: ReciprocityLedger, as: "reciprocity_ledger" },
    ],
  });

  if (peers.length === 0) {
    return { plan: [], total_peers: 0 };
  }

  // Filtrer par score de confiance minimum
  const candidates = peers.filter((p) => {
    const score = p.trust_score?.overall_score ?? 0.5;
    return score >= minTrust;
  });

  if (candidates.length === 0) {
    return { plan: [], total_peers: 0 };
  }

  // Pré-calculer les valeurs brutes pour normalisation
  const capValues = candidates.map((p) => Number(p.declared_available_gbps));
  const latValues = candidates.map((p) => Number(p.measured_latency_ms ?? 0));

  const maxCap = Math.max(...capValues);
  const minLat = Math.min(...latValues);
  const maxLat = Math.max(...latValues);
  const latRange = maxLat - minLat;

  // Calculer le score WSM de chaque pair
  const scored = candidates.map((peer, i) => {
    const Cp     = maxCap > 0   ? capValues[i] / maxCap                              : 0;
    const Lp_inv = latRange > 0 ? 1 - (latValues[i] - minLat) / latRange            : 1;
    const Tp     = peer.trust_score?.overall_score ?? 0.5;

    const ledger   = peer.reciprocity_ledger;
    const received = Number(ledger?.credits_received ?? 0);
    const given    = Number(ledger?.credits_given    ?? 0);
    const Rp       = received / (received + given + EPSILON);

    const score = computeScore({ Cp, Lp_inv, Tp, Rp });

    return {
      peer,
      cap_disp: capValues[i],
      score,
      criteria: { Cp, Lp_inv, Tp, Rp },
    };
  });

  // Somme totale des scores → base de la répartition proportionnelle
  const totalScore = scored.reduce((sum, c) => sum + c.score, 0);

  // Trier par score décroissant (pour la lisibilité)
  scored.sort((a, b) => b.score - a.score);

  // Construire le plan : pour chaque pair, son poids et son pourcentage du flux
  const plan = scored.map((candidate) => {
    // w_i = Score(p_i) / Σ Score(p_j)
    const weight         = totalScore > 0 ? candidate.score / totalScore : 1 / scored.length;
    const allocation_pct = Number((weight * 100).toFixed(2));

    const entry = {
      peer: {
        peer_id:                 candidate.peer.peer_id,
        peer_name:               candidate.peer.peer_name,
        organization_name:       candidate.peer.organization_name,
        api_endpoint_url:        candidate.peer.api_endpoint_url,
        declared_available_gbps: candidate.cap_disp,
        measured_latency_ms:     candidate.peer.measured_latency_ms,
        trust_level:             candidate.peer.trust_score?.trust_level ?? "BRONZE",
      },
      wsm_score:      Number(candidate.score.toFixed(4)),
      weight:         Number(weight.toFixed(4)),
      allocation_pct,
      criteria: {
        capacity_normalized:     Number(candidate.criteria.Cp.toFixed(4)),
        latency_normalized_inv:  Number(candidate.criteria.Lp_inv.toFixed(4)),
        trust_score:             Number(candidate.criteria.Tp.toFixed(4)),
        reciprocity:             Number(candidate.criteria.Rp.toFixed(4)),
      },
    };

    // Si le volume total est connu, ajouter l'estimation en Gbps
    if (overflowGbps !== undefined && overflowGbps > 0) {
      entry.estimated_gbps = Number((weight * overflowGbps).toFixed(3));
    }

    return entry;
  });

  return {
    plan,
    total_peers: plan.length,
    ...(overflowGbps !== undefined && { overflow_gbps_provided: overflowGbps }),
  };
}

module.exports = { selectPeers, computeScore };
