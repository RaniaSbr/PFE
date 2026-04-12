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
 * Contrainte d'allocation : alloc_p ≤ 0.70 · cap_disp_p  (configurable via max_capacity_share_pct)
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
 * Sélectionne les pairs candidats et alloue le volume excédentaire.
 *
 * @param {number} overflowGbps  - Volume excédentaire à redistribuer (Gbps)
 * @param {object} options
 * @param {number} [options.minTrustScore]   - Score minimum pour participer (défaut : 0.0)
 * @param {boolean} [options.ignoreTrust]    - Ignorer le filtre de confiance (mode CRITIQUE)
 * @returns {Promise<{ plan: Array, remaining_gbps: number }>}
 *   plan : [{ peer, allocated_gbps, score, criteria }]
 *   remaining_gbps : volume non couvert (0 si tous les pairs suffisent)
 */
async function selectPeers(overflowGbps, { minTrustScore = 0.0, ignoreTrust = false } = {}) {
  // Récupérer la politique active pour la contrainte d'allocation
  const node = await LocalNodeConfig.findOne();
  const policy = node
    ? await PolicyConfig.findOne({
        where: { node_id: node.node_id, is_current: true },
        order: [["created_at", "DESC"]],
      })
    : null;

  const maxSharePct = Number(policy?.max_capacity_share_pct ?? 70) / 100;
  const minTrust = ignoreTrust ? 0.0 : minTrustScore;

  // Pairs éligibles : ACTIVE, non BANNED, avec de la capacité disponible
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
    return { plan: [], remaining_gbps: overflowGbps };
  }

  // Filtrer par score de confiance minimum
  const candidates = peers.filter((p) => {
    const score = p.trust_score?.overall_score ?? 0.5;
    return score >= minTrust;
  });

  if (candidates.length === 0) {
    return { plan: [], remaining_gbps: overflowGbps };
  }

  // Pré-calculer les valeurs brutes pour normalisation
  const capValues = candidates.map((p) => Number(p.declared_available_gbps));
  const latValues = candidates.map((p) => Number(p.measured_latency_ms ?? 0));

  const maxCap = Math.max(...capValues);
  const minLat = Math.min(...latValues);
  const maxLat = Math.max(...latValues);
  const latRange = maxLat - minLat;

  // Construire les données normalisées de chaque pair
  const scored = candidates.map((peer, i) => {
    const Cp = maxCap > 0 ? capValues[i] / maxCap : 0;

    // Lp' = 1 - (Lp - Lmin) / (Lmax - Lmin) ; si Lmax = Lmin → Lp' = 1 pour tous
    const Lp_inv = latRange > 0 ? 1 - (latValues[i] - minLat) / latRange : 1;

    const Tp = peer.trust_score?.overall_score ?? 0.5;

    const ledger = peer.reciprocity_ledger;
    const received = Number(ledger?.credits_received ?? 0);
    const given = Number(ledger?.credits_given ?? 0);
    const Rp = received / (received + given + EPSILON);

    const score = computeScore({ Cp, Lp_inv, Tp, Rp });

    return {
      peer,
      cap_disp: capValues[i],
      score,
      criteria: { Cp, Lp_inv, Tp, Rp },
    };
  });

  // Trier par score décroissant
  scored.sort((a, b) => b.score - a.score);

  // Allocation gloutonne avec contrainte de sécurité
  const plan = [];
  let remaining = overflowGbps;

  for (const candidate of scored) {
    if (remaining <= 0) break;

    const maxAlloc = candidate.cap_disp * maxSharePct;
    if (maxAlloc <= 0) continue;

    const allocated = Math.min(remaining, maxAlloc);
    remaining -= allocated;

    plan.push({
      peer: {
        peer_id: candidate.peer.peer_id,
        peer_name: candidate.peer.peer_name,
        organization_name: candidate.peer.organization_name,
        api_endpoint_url: candidate.peer.api_endpoint_url,
        declared_available_gbps: candidate.cap_disp,
        measured_latency_ms: candidate.peer.measured_latency_ms,
        trust_level: candidate.peer.trust_score?.trust_level ?? "BRONZE",
      },
      allocated_gbps: Number(allocated.toFixed(3)),
      score: Number(candidate.score.toFixed(4)),
      criteria: {
        capacity_normalized: Number(candidate.criteria.Cp.toFixed(4)),
        latency_normalized_inv: Number(candidate.criteria.Lp_inv.toFixed(4)),
        trust_score: Number(candidate.criteria.Tp.toFixed(4)),
        reciprocity: Number(candidate.criteria.Rp.toFixed(4)),
      },
    });
  }

  return {
    plan,
    remaining_gbps: Number(Math.max(0, remaining).toFixed(3)),
    total_allocated_gbps: Number((overflowGbps - Math.max(0, remaining)).toFixed(3)),
    peers_selected: plan.length,
  };
}

module.exports = { selectPeers, computeScore };
