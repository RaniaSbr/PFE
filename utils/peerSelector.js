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
 * @param {string[]} [options.peerIds]       - Restreint le calcul à cet ensemble de pairs
 *   précis (ex: ceux ayant déjà accepté) — dans ce cas, le filtre d'éligibilité
 *   (statut, confiance minimale) est ignoré : l'appelant a déjà décidé du périmètre.
 * @param {object} [options.capacityOverrides] - { peer_id: capacité_gbps } — remplace
 *   declared_available_gbps par cette valeur pour le critère C (ex: accepted_volume_gbps
 *   déclaré au moment de l'acceptation, plus récent que la dernière capacité connue).
 * @returns {Promise<{ plan: Array, total_peers: number }>}
 *   plan : [{ peer, allocation_pct, weight, score, estimated_gbps?, criteria }]
 */
async function selectPeers({
  overflowGbps, minTrustScore = 0.0, ignoreTrust = false,
  peerIds = null, capacityOverrides = null,
} = {}) {
  const node = await LocalNodeConfig.findOne();
  const policy = node
    ? await PolicyConfig.findOne({
        where: { node_id: node.node_id, is_current: true },
        order: [["created_at", "DESC"]],
      })
    : null;

  // Appliquer le seuil de la politique si aucun seuil explicite n'est fourni
  const policyMin = policy?.min_trust_score_to_help ?? 0.0;
  const minTrust  = ignoreTrust ? 0.0 : Math.max(minTrustScore, policyMin);

  // Pairs éligibles : ACTIVE, avec capacité disponible — ou, si peerIds est
  // fourni, exactement cet ensemble (le périmètre a déjà été décidé ailleurs,
  // ex. les pairs ayant accepté une sollicitation).
  const where = peerIds
    ? { peer_id: { [Op.in]: peerIds } }
    : {
        status: { [Op.in]: ["ACTIVE"] },
        declared_available_gbps: { [Op.gt]: 0 },
      };

  const peers = await Peer.findAll({
    where,
    include: [
      { model: TrustScore, as: "trust_score" },
      { model: ReciprocityLedger, as: "reciprocity_ledger" },
    ],
  });

  if (peers.length === 0) {
    return { plan: [], total_peers: 0 };
  }

  // Filtrer par score de confiance minimum — sauté si peerIds est fourni,
  // puisque l'appelant a déjà sélectionné ce périmètre précis.
  const candidates = peerIds
    ? peers
    : peers.filter((p) => {
        // Les vrais nœuds sans historique de sessions reçoivent un score par défaut élevé
        const score = p.trust_score?.overall_score ?? 0.75;
        return score >= minTrust;
      });

  if (candidates.length === 0) {
    return { plan: [], total_peers: 0 };
  }

  // Pré-calculer les valeurs brutes pour normalisation — la capacité utilisée
  // pour le critère C peut être remplacée par capacityOverrides (ex: le
  // accepted_volume_gbps déclaré à l'acceptation, plus à jour que
  // declared_available_gbps issu du dernier heartbeat).
  const capValues = candidates.map((p) =>
    Number(capacityOverrides?.[p.peer_id] ?? p.declared_available_gbps),
  );
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

  // Trier par score croissant pour garantir la participation de tous les pairs
  scored.sort((a, b) => a.score - b.score);

  // Construire le plan : pour chaque pair, son poids et son pourcentage du flux
  const plan = scored.map((candidate) => {
    // w_i = Score(p_i) / Σ Score(p_j)
    const weight = totalScore > 0 ? candidate.score / totalScore : 1 / scored.length;

    // Pourcentage brut issu du score WSM — minimum 1 % : un pair avec un poids
    // non nul ne doit jamais être arrondi à 0 (sinon alloc_i=0 dans le WRR,
    // qui l'exclurait silencieusement de toute distribution de paquets).
    const wsm_allocation_pct = Math.max(1, Math.floor(weight * 100));

    // Taux de capacité : part maximale que ce pair peut physiquement absorber
    // capacity_ratio = cap_disp / overflow_gbps (plafonné à 100 %, minimum 1 %)
    const capacity_ratio_pct = (overflowGbps !== undefined && overflowGbps > 0)
      ? Math.max(1, Math.min(100, Math.floor((candidate.cap_disp / overflowGbps) * 100)))
      : 100;

    // Contrainte : allocation ≤ taux de capacité (un pair ne peut pas absorber
    // plus que ce qu'il déclare disponible par rapport au volume à redistribuer)
    const allocation_pct = Math.min(wsm_allocation_pct, capacity_ratio_pct);

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
      wsm_score:           Number(candidate.score.toFixed(4)),
      weight:              Number(weight.toFixed(4)),
      wsm_allocation_pct,   // allocation brute selon le score WSM
      capacity_ratio_pct,   // plafond physique (cap_disp / overflow_gbps)
      allocation_pct,       // allocation effective = min(wsm, capacité)
      criteria: {
        capacity_normalized:     Number(candidate.criteria.Cp.toFixed(4)),
        latency_normalized_inv:  Number(candidate.criteria.Lp_inv.toFixed(4)),
        trust_score:             Number(candidate.criteria.Tp.toFixed(4)),
        reciprocity:             Number(candidate.criteria.Rp.toFixed(4)),
      },
    };

    // Gbps estimés : poids × overflow, plafonné par la capacité disponible
    if (overflowGbps !== undefined && overflowGbps > 0) {
      const raw_gbps = weight * overflowGbps;
      entry.estimated_gbps = Number(Math.min(raw_gbps, candidate.cap_disp).toFixed(3));
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
