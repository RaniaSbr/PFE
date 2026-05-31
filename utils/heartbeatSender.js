/**
 * utils/heartbeatSender.js
 * Service d'envoi automatique de heartbeats aux pairs de la coalition.
 *
 * Chaque nœud envoie périodiquement son état à tous ses pairs connus.
 * Les requêtes utilisent le client mTLS → certificat client présenté à chaque appel.
 *
 * Flux complet :
 *   1. Lire l'état local (charge, capacité disponible)
 *   2. Générer un JWT RS256 (60s) pour s'authentifier
 *   3. Envoyer POST /heartbeat à chaque pair via HTTPS + certificat client
 *   4. Mesurer le round-trip time (RTT)
 *   5. Marquer les pairs injoignables comme INACTIVE après N échecs
 */

"use strict";

const { Peer, LocalNodeConfig } = require("../models");
const { generateToken }         = require("../middleware/auth");
const httpsClient               = require("./httpsClient");

const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 30_000; // 30s
const MAX_MISSED            = parseInt(process.env.MAX_MISSED_HEARTBEATS)  || 3;

let _timer = null;

// ─── Envoi d'un heartbeat à un seul pair ─────────────────────────────────────

async function sendHeartbeatToPeer(peer, localNode, token) {
  const url  = `${peer.api_endpoint_url.replace(/\/$/, "")}/heartbeat`;
  const sentAt = Date.now();

  const body = {
    peer_id:                localNode.node_id,
    reported_status:        localNode.status        || "ACTIVE",
    reported_load_pct:      localNode.current_load_percent ?? 0,
    reported_available_gbps: localNode.max_scrubbing_capacity_gbps *
                              (1 - (localNode.current_load_percent ?? 0) / 100),
    round_trip_time_ms:     null, // sera mis à jour après réponse
  };

  try {
    const resp = await httpsClient.post(url, body, { token });
    const rtt  = Date.now() - sentAt;

    // Remettre à jour le RTT dans le corps (information pour les logs)
    body.round_trip_time_ms = rtt;

    if (resp.status === 201 || resp.status === 200) {
      console.log(
        `[Heartbeat] ✓ → ${peer.peer_name} (${rtt}ms) | status=${localNode.status}`
      );

      // Réinitialiser le compteur d'échecs si le pair répond
      if (peer.consecutive_missed_heartbeats > 0) {
        await peer.update({
          consecutive_missed_heartbeats: 0,
          status: peer.status === "BANNED" ? "BANNED" : "ACTIVE",
        });
      }
    } else {
      console.warn(`[Heartbeat] ✗ → ${peer.peer_name} HTTP ${resp.status}`);
      await incrementMissed(peer);
    }
  } catch (err) {
    console.warn(`[Heartbeat] ✗ → ${peer.peer_name} : ${err.message}`);
    await incrementMissed(peer);
  }
}

// ─── Gestion des pairs injoignables ──────────────────────────────────────────

async function incrementMissed(peer) {
  const missed = (peer.consecutive_missed_heartbeats || 0) + 1;
  const update = { consecutive_missed_heartbeats: missed };

  if (missed >= MAX_MISSED && peer.status !== "BANNED") {
    update.status = "INACTIVE";
    console.warn(
      `[Heartbeat] ${peer.peer_name} marqué INACTIVE (${missed} échecs consécutifs)`
    );
  }

  await peer.update(update);
}

// ─── Cycle d'envoi complet ───────────────────────────────────────────────────

async function sendHeartbeats() {
  try {
    const localNode = await LocalNodeConfig.findOne();
    if (!localNode) {
      console.warn("[Heartbeat] Nœud local non initialisé — heartbeat ignoré");
      return;
    }

    // Générer un token JWT RS256 (60s) pour s'authentifier auprès des pairs
    let token;
    try {
      token = generateToken(localNode.node_id);
    } catch (e) {
      console.warn("[Heartbeat] Impossible de générer le JWT :", e.message);
      return;
    }

    // Récupérer tous les pairs actifs ou injoignables (pas les bannis)
    const peers = await Peer.findAll({
      where: { status: ["ACTIVE", "INACTIVE", "MAINTENANCE"] },
    });

    if (peers.length === 0) {
      console.log("[Heartbeat] Aucun pair enregistré");
      return;
    }

    console.log(`[Heartbeat] Envoi à ${peers.length} pair(s)...`);

    // Envoyer en parallèle à tous les pairs
    await Promise.allSettled(
      peers.map((peer) => sendHeartbeatToPeer(peer, localNode, token))
    );
  } catch (err) {
    console.error("[Heartbeat] Erreur cycle :", err.message);
  }
}

// ─── Démarrage / Arrêt du service ────────────────────────────────────────────

function start() {
  if (_timer) return; // déjà démarré

  console.log(
    `[Heartbeat] Service démarré — intervalle : ${HEARTBEAT_INTERVAL_MS / 1000}s`
  );

  // Premier envoi après 10s (laisser le temps aux autres nœuds de démarrer)
  setTimeout(() => {
    sendHeartbeats();
    _timer = setInterval(sendHeartbeats, HEARTBEAT_INTERVAL_MS);
  }, 10_000);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log("[Heartbeat] Service arrêté");
  }
}

module.exports = { start, stop, sendHeartbeats };
