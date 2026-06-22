/**
 * utils/heartbeatSender.js
 * Service d'annonce événementielle aux pairs de la coalition.
 *
 * Contrairement à un heartbeat périodique, ce module n'envoie un signal
 * à ses pairs que lors d'un événement précis :
 *   1. Adhésion à la coalition (annonce initiale au démarrage du nœud)
 *   2. Mise à jour de ses propres paramètres (capacité, charge déclarée)
 *   3. Départ de la coalition (cf. routes/discovery.js — POST /peers/goodbye)
 *
 * Aucun minuteur, aucune répétition automatique — chaque appel correspond
 * à un événement réel survenu côté nœud local.
 *
 * Flux d'un envoi :
 *   1. Lire l'état local courant (charge, capacité disponible)
 *   2. Envoyer POST /heartbeat à chaque pair via HTTPS (+ x-node-secret)
 *   3. Mesurer le round-trip time (RTT) pour alimenter le critère L du WSM
 *
 * La détection d'un pair injoignable est désormais réactive (cf.
 * routes/coalition.js — POST /help/request), pas proactive : un pair
 * silencieux reste ACTIVE jusqu'à ce qu'une vraie sollicitation échoue.
 */

"use strict";

const { Peer, LocalNodeConfig } = require("../models");
const httpsClient               = require("./httpsClient");
const { Op }                    = require("sequelize");

const NODE_SECRET = process.env.JWT_SECRET || "shieldnet-secret-key-2025";

// ─── Envoi d'une annonce à un seul pair ──────────────────────────────────────

async function sendAnnounceToPeer(peer, localNode) {
  const url    = `${peer.api_endpoint_url.replace(/\/$/, "")}/heartbeat`;
  const sentAt = Date.now();

  const body = {
    peer_id:                 localNode.node_id,
    peer_name:                localNode.node_name,
    reported_status:          localNode.status || "ACTIVE",
    reported_load_pct:        localNode.current_load_percent ?? 0,
    reported_available_gbps:  localNode.max_scrubbing_capacity_gbps *
                               (1 - (localNode.current_load_percent ?? 0) / 100),
    round_trip_time_ms:       null,
  };

  // Shared secret inter-nœuds (x-node-secret) — accepté par le middleware
  // auth pour les appels coalition (auth.js).
  const headers = {
    "x-node-secret": NODE_SECRET,
    "x-node-id":     localNode.node_id,
  };

  try {
    const resp = await httpsClient.post(url, body, { headers });
    const rtt  = Date.now() - sentAt;

    if (resp.status === 201 || resp.status === 200) {
      console.log(
        `[Annonce] ✓ → ${peer.peer_name} (${rtt}ms) | status=${localNode.status}`
      );
      await peer.update({
        status: peer.status === "BANNED" ? "BANNED" : "ACTIVE",
        measured_latency_ms: rtt,
      });
    } else {
      console.warn(`[Annonce] ✗ → ${peer.peer_name} HTTP ${resp.status}`);
    }
  } catch (err) {
    // Pair injoignable lors d'une annonce : pas de marquage INACTIVE ici —
    // la détection de panne est désormais réactive, déclenchée par un échec
    // de /help/request pendant une vraie sollicitation (cf. coalition.js).
    console.warn(`[Annonce] ✗ → ${peer.peer_name} : ${err.message}`);
  }
}

// ─── Diffusion d'un événement à tous les pairs connus ────────────────────────

/**
 * Diffuse l'état courant du nœud local à tous ses pairs connus.
 * Appelée sur événement (adhésion, mise à jour de paramètres) —
 * jamais sur un minuteur périodique.
 */
async function announceToCoalition() {
  try {
    const localNode = await LocalNodeConfig.findOne();
    if (!localNode) {
      console.warn("[Annonce] Nœud local non initialisé — annonce ignorée");
      return;
    }

    const peers = await Peer.findAll({
      where: {
        status: ["ACTIVE", "INACTIVE", "MAINTENANCE"],
        peer_name: { [Op.notLike]: "sim-%" },
        api_endpoint_url: { [Op.notLike]: "%.shieldnet.local%" },
      },
    });

    if (peers.length === 0) {
      console.log("[Annonce] Aucun pair enregistré");
      return;
    }

    console.log(`[Annonce] Diffusion à ${peers.length} pair(s)...`);

    await Promise.allSettled(
      peers.map((peer) => sendAnnounceToPeer(peer, localNode))
    );
  } catch (err) {
    console.error("[Annonce] Erreur de diffusion :", err.message);
  }
}

// ─── Événements déclencheurs ─────────────────────────────────────────────────

/**
 * Événement 1 — Adhésion à la coalition.
 * Appelée une seule fois au démarrage du nœud (annonce initiale).
 */
function announceJoin() {
  console.log("[Annonce] Adhésion à la coalition — diffusion initiale");
  // Délai court pour laisser les autres nœuds finir leur propre démarrage.
  setTimeout(announceToCoalition, 10_000);
}

/**
 * Événement 2 — Mise à jour des paramètres locaux (capacité, charge).
 * À appeler après toute modification de LocalNodeConfig.
 */
function announceUpdate() {
  console.log("[Annonce] Mise à jour des paramètres — diffusion");
  return announceToCoalition();
}

module.exports = { announceJoin, announceUpdate, announceToCoalition };
