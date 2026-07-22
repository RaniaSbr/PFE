const express     = require("express");
const httpsClient = require("../utils/httpsClient");
const { Op }      = require("sequelize");
const {
  Attack,
  HelpSession,
  LocalNodeConfig,
  Peer,
  PeerCapability,
  ReciprocityLedger,
} = require("../models");
const { logAudit, logMessage } = require("../utils/logger");
const { fetchCrFromNetwork, recalculateAndSave } = require("../utils/trustManager");
const { selectPeers } = require("../utils/peerSelector");

const router = express.Router();

const NODE_SECRET = process.env.JWT_SECRET || "shieldnet-secret-key-2025";
const PEER_HEADERS = (extra = {}) => ({
  "X-Node-Secret": NODE_SECRET,
  ...extra,
});

/**
 * @swagger
 * /alert:
 *   post:
 *     tags: [Coalition]
 *     summary: Signaler une attaque DDoS detectee (signal boite de detection)
 *     description: "Recoit le signal de la boite de detection externe. Le volume peak est une estimation observable ; la severite est calculee automatiquement a la cloture via POST /attack/over."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               peak_volume_gbps: { type: number, description: "Volume de pointe estime (Gbps) — alias volume_gbps accepte" }
 *               overflow_volume_gbps: { type: number, description: "Volume depassant la capacite locale (Gbps)" }
 *               local_capacity_at_detection: { type: number, description: "Capacite locale disponible au moment de la detection (Gbps)" }
 *               target_ip_range: { type: string, description: "Plage IP ciblee (ex: 192.168.1.0/24)" }
 *               target_service: { type: string, description: "Service cible (ex: HTTP, DNS)" }
 *               target_port: { type: integer, description: "Port cible (0-65535)" }
 *               target_protocol: { type: string, description: "Protocole (ex: TCP, UDP)" }
 *               detected_at: { type: string, format: date-time, description: "Horodatage de detection (defaut: maintenant)" }
 *     responses:
 *       201:
 *         description: Attaque creee
 *       200:
 *         description: Attaque mise a jour (si attack_id fourni)
 *       400:
 *         description: Donnees invalides
 *
 * /attacks:
 *   get:
 *     tags: [Coalition]
 *     summary: Lister les attaques
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [DETECTED, ANALYZING, MITIGATING_LOCAL, ESCALATED_TO_COALITION, MITIGATED, ENDED, UNMITIGATED] }
 *       - in: query
 *         name: severity
 *         schema: { type: string, enum: [LOW, MEDIUM, HIGH, CRITICAL] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: Liste des attaques
 *
 * /attacks/{attack_id}:
 *   get:
 *     tags: [Coalition]
 *     summary: Detai d'une attaque avec ses sessions d'aide
 *     parameters:
 *       - in: path
 *         name: attack_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Attaque trouvee
 *       404:
 *         description: Attaque introuvable
 *
 * /help/request:
 *   post:
 *     tags: [Coalition]
 *     summary: Demander l'aide d'un pair pour une attaque
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
 *               allocation_pct: { type: number, description: "Pourcentage du flux alloue a ce pair (0-100)" }
 *               direction: { type: string, enum: [OUTBOUND_REQUEST, INBOUND_REQUEST, OUTBOUND_OFFER, INBOUND_OFFER], default: OUTBOUND_REQUEST }
 *     responses:
 *       201:
 *         description: Session creee en statut REQUESTED
 *       400:
 *         description: Donnees invalides
 *       403:
 *         description: Pair banni ou expulse
 *       404:
 *         description: Attaque ou pair introuvable
 *
 * /help/request/broadcast:
 *   post:
 *     tags: [Coalition]
 *     summary: Sollicitation diffusee - demander l'aide a tous les pairs actifs en un seul appel
 *     description: "Equivalent serveur de la boucle que fait le dashboard : cree une session REQUESTED pour chaque pair ACTIVE de la coalition, sans allocation (le volume/allocation n'existent qu'apres acceptation puis POST /attack/:id/allocate)."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [attack_id]
 *             properties:
 *               attack_id: { type: string, format: uuid }
 *               direction: { type: string, enum: [OUTBOUND_REQUEST, INBOUND_REQUEST, OUTBOUND_OFFER, INBOUND_OFFER], default: OUTBOUND_REQUEST }
 *     responses:
 *       201:
 *         description: Une session REQUESTED creee par pair actif sollicite
 *       400:
 *         description: Donnees invalides
 *       404:
 *         description: Attaque introuvable
 *
 * /help/offer:
 *   post:
 *     tags: [Coalition]
 *     summary: Proposer proactivement l'aide a un pair (auto_offer_enabled)
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
 *               allocation_pct: { type: number }
 *     responses:
 *       201:
 *         description: Offre creee en statut OFFERED
 *
 * /help/{session_id}/accept:
 *   put:
 *     tags: [Coalition]
 *     summary: Accepter une session d'aide (REQUESTED -> ACCEPTED)
 *     parameters:
 *       - in: path
 *         name: session_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               accepted_volume_gbps: { type: number, description: "Volume que le pair accepte de traiter (Gbps)" }
 *               tunnel_type: { type: string, enum: [GRE, VXLAN, IPSEC, BGP_FLOWSPEC] }
 *               response_time_ms: { type: number, description: "Temps de reponse mesure (ms)" }
 *     responses:
 *       200:
 *         description: Session acceptee
 *       404:
 *         description: Session introuvable
 *       409:
 *         description: Statut invalide (doit etre REQUESTED, OFFERED ou NEGOTIATING)
 *
 * /help/{session_id}/reject:
 *   put:
 *     tags: [Coalition]
 *     summary: Rejeter une session d'aide (REQUESTED -> REJECTED)
 *     parameters:
 *       - in: path
 *         name: session_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               rejection_reason: { type: string, description: "Raison du refus (ex: capacite insuffisante)" }
 *     responses:
 *       200:
 *         description: Session rejetee
 *       404:
 *         description: Session introuvable
 *       409:
 *         description: Statut invalide (doit etre REQUESTED, OFFERED ou NEGOTIATING)
 *
 * /traffic/redirect:
 *   post:
 *     tags: [Coalition]
 *     summary: Activer la redirection du trafic (ACCEPTED -> ACTIVE)
 *     description: "Signal applicatif de demarrage de la redirection. La redirection reseau reelle (tunnel GRE/VXLAN/IPSEC) est geree hors perimetre par l'infrastructure du noeud victime."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [session_id, tunnel_type]
 *             properties:
 *               session_id: { type: string, format: uuid }
 *               tunnel_type: { type: string, enum: [GRE, VXLAN, IPSEC, BGP_FLOWSPEC] }
 *               volume_gbps: { type: number, description: "Volume redirige vers ce pair (Gbps)" }
 *     responses:
 *       200:
 *         description: Session passee en statut ACTIVE
 *       404:
 *         description: Session introuvable
 *       409:
 *         description: Session pas en statut ACCEPTED
 *
 * /attack/over:
 *   post:
 *     tags: [Coalition]
 *     summary: Cloture une attaque, met a jour credits et calcule la severite
 *     description: "Marque les sessions comme COMPLETED, met a jour les ledgers de reciprocite, capture Cr et calcule la severite finale selon le volume total filtre."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [attack_id]
 *             properties:
 *               attack_id: { type: string, format: uuid }
 *               session_ids: { type: array, items: { type: string, format: uuid }, description: "Sessions a clotures (statut -> COMPLETED)" }
 *               attack_duration_seconds: { type: integer, description: "Duree totale de l'attaque en secondes" }
 *     responses:
 *       200:
 *         description: Attaque cloturee, severite calculee, credits mis a jour
 *       404:
 *         description: Attaque introuvable
 *
 * /sessions:
 *   get:
 *     tags: [Coalition]
 *     summary: Historique complet des sessions d'aide
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100, maximum: 500 }
 *     responses:
 *       200:
 *         description: Liste des sessions
 *
 * /sessions/active:
 *   get:
 *     tags: [Coalition]
 *     summary: Sessions en cours (REQUESTED, ACCEPTED, ACTIVE...)
 *     responses:
 *       200:
 *         description: Sessions actives
 *
 * /sessions/{session_id}:
 *   get:
 *     tags: [Coalition]
 *     summary: Detail d'une session avec attaque et pair associes
 *     parameters:
 *       - in: path
 *         name: session_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Session trouvee
 *       404:
 *         description: Session introuvable
 *
 * /sessions/{id}:
 *   patch:
 *     tags: [Coalition]
 *     summary: Synchroniser l'etat final d'une session sur la copie locale de l'aidant
 *     description: "Appele par la victime a la cloture pour propager allocation_pct, actual_volume_gbps, credits_exchanged et le statut COMPLETED vers la copie de la session que detient l'aidant."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string }
 *               allocation_pct: { type: number }
 *               actual_volume_gbps: { type: number }
 *               credits_exchanged: { type: number }
 *               completed_at: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Session mise a jour
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

/**
 * Sollicite un pair pour une attaque donnée — crée la session et gère le
 * forward réel (ou la décision simulée pour un pair virtuel). Factorisé pour
 * être réutilisé à la fois par POST /help/request et par la reconsidération
 * automatique de la coalition (cf. reconsiderCoalition ci-dessous).
 */
async function solicitPeer(attack, peer, requestingNodeId, extra = {}) {
  // Sollicitation pure : "peux-tu aider ?" — sans allocation ni volume.
  // Le volume n'existe qu'à partir de l'acceptation (accepted_volume_gbps,
  // déclaré par le pair), et l'allocation n'existe qu'après /attack/:id/allocate.
  const session = await HelpSession.create({
    attack_id: attack.attack_id,
    requesting_node_id: requestingNodeId,
    helping_peer_id: peer.peer_id,
    direction: extra.direction || "OUTBOUND_REQUEST",
    status: "REQUESTED",
    requested_at: new Date(),
  });

  if (peer.api_endpoint_url) {
    // Pairs virtuels de simulation (.shieldnet.local ou vnode-) : acceptation
    // automatique sans forwarding réseau (pas d'endpoint réel joignable).
    const isVirtualPeer =
      peer.api_endpoint_url.includes(".shieldnet.local") ||
      (peer.peer_name && peer.peer_name.startsWith("vnode-"));

    if (isVirtualPeer) {
      // Simuler la décision du pair virtuel : refus probable selon niveau de confiance
      const refuseProb = { GOLD: 0.15, SILVER: 0.25, BRONZE: 0.45, SUSPECT: 0.75 }[peer.trust_level] ?? 0.50;
      if (Math.random() < refuseProb) {
        const reasons = ["Capacité insuffisante", "Charge trop élevée", "Politique interne", "Ressources réservées"];
        await session.update({
          status: "REJECTED",
          rejection_reason: reasons[Math.floor(Math.random() * reasons.length)],
        });
      } else {
        await session.update({
          status: "ACCEPTED",
          accepted_volume_gbps: Number(peer.declared_available_gbps ?? 0),
          responded_at: new Date(),
        });
      }
    } else {
      const localNode = await LocalNodeConfig.findOne();
      try {
        const fwdUrl = `${peer.api_endpoint_url}/help/offer`;
        console.log(`[coalition] → forward help/offer to ${fwdUrl}`);
        const fwdResult = await httpsClient.post(
          fwdUrl,
          {
            session_id:               session.session_id,
            attack_id:                attack.attack_id,
            attack_details:           attack.toJSON(),
            helping_peer_id:          peer.peer_id,
            requesting_node_id:       requestingNodeId,
            requesting_node_name:     localNode?.node_name ?? null,
            requesting_node_endpoint: localNode?.api_endpoint_url ?? null,
            requesting_node_org:      localNode?.organization_name ?? null,
            requesting_node_type:     localNode?.organization_type ?? null,
            requesting_node_capacity: localNode?.max_scrubbing_capacity_gbps ?? null,
            direction:                "INBOUND_OFFER",
          },
          { headers: PEER_HEADERS({ "X-Node-Id": requestingNodeId }), timeout: 8000 }
        );
        console.log(`[coalition] ← forward result: HTTP ${fwdResult.status}`, JSON.stringify(fwdResult.data));
        await session.update({ status: "OFFERED" });
      } catch (e) {
        console.error(`[coalition] forward help/offer FAILED: ${e.message}`);
        // Détection réactive (pas de heartbeat périodique) : un pair
        // injoignable lors d'une vraie sollicitation est marqué INACTIVE
        // à cet instant — pas avant, faute de minuteur de surveillance.
        await peer.update({ status: peer.status === "BANNED" ? "BANNED" : "INACTIVE" });
        // Session reste REQUESTED — le pair n'a pas pu être notifié.
      }
    }
  }

  logMessage({ message_type: "HELP_REQUEST", direction: "SENT", peer_id: peer.peer_id, priority: "CRITICAL" });
  return session;
}

/**
 * Reconsidération automatique de la coalition pendant une attaque en cours.
 *
 * Déclenchée sur trois événements (cf. routes/discovery.js) :
 *   - un pair aidant quitte la coalition ou devient INACTIVE
 *   - un pair aidant met à jour sa capacité déclarée
 *   - un nouveau pair rejoint la coalition
 *
 * Le WSM (selectPeers) n'est pas modifié — seule la fréquence à laquelle on
 * le réinterroge change : à chaud, dès qu'un événement d'adhésion survient,
 * au lieu d'une seule fois à la sélection initiale.
 */
async function reconsiderCoalition(triggerPeerId, reason) {
  const ongoingAttacks = await Attack.findAll({ where: { status: { [Op.ne]: "ENDED" } } });
  if (ongoingAttacks.length === 0) return;

  const localNodeId = await getLocalNodeId();
  if (!localNodeId) return;

  const { selectPeers } = require("../utils/peerSelector");

  for (const attack of ongoingAttacks) {
    let activeSessions = await HelpSession.findAll({
      where: { attack_id: attack.attack_id, status: "ACTIVE" },
    });

    // Le pair déclencheur avait-il une session active sur cette attaque ?
    const triggerSession = activeSessions.find((s) => s.helping_peer_id === triggerPeerId);
    if (triggerSession) {
      const triggerPeer = await Peer.findByPk(triggerPeerId);

      if (!triggerPeer || triggerPeer.status !== "ACTIVE") {
        // Le pair est parti ou injoignable : sa session ne peut plus contribuer.
        await triggerSession.update({
          status: "FAILED",
          failure_reason: `Pair ${reason} pendant la mitigation`,
          updated_at: new Date(),
        });
        logAudit({
          event_type: "MANUAL_OVERRIDE",
          severity: "WARNING",
          actor: "system",
          target: attack.attack_id,
          description: `[Reconsidération] Session ${triggerSession.session_id} interrompue — pair ${triggerPeerId} (${reason}).`,
        });
      } else {
        // Le pair reste actif mais sa capacité déclarée a pu changer —
        // recaler le volume de sa session sans dépasser sa nouvelle capacité.
        const newCap = Number(triggerPeer.declared_available_gbps ?? 0);
        const promised = Number(triggerSession.accepted_volume_gbps ?? newCap);
        const adjusted = Math.min(newCap, promised);
        if (newCap > 0 && Number(triggerSession.actual_volume_gbps) !== adjusted) {
          await triggerSession.update({ actual_volume_gbps: adjusted, updated_at: new Date() });
        }
      }
    }

    // Couverture actuelle après prise en compte de l'événement
    activeSessions = await HelpSession.findAll({
      where: { attack_id: attack.attack_id, status: "ACTIVE" },
    });
    const currentlyCovered = activeSessions.reduce(
      (sum, s) => sum + Number(s.actual_volume_gbps ?? 0), 0,
    );
    const overflow = Number(attack.overflow_volume_gbps ?? 0);
    const remainingNeed = Math.max(0, overflow - currentlyCovered);

    if (remainingNeed <= 0) continue; // couverture déjà suffisante, rien à faire

    // Pairs déjà engagés (REQUESTED..ACTIVE) sur cette attaque — à exclure
    const engagedSessions = await HelpSession.findAll({
      where: {
        attack_id: attack.attack_id,
        status: { [Op.in]: ["REQUESTED", "OFFERED", "NEGOTIATING", "ACCEPTED", "ACTIVE"] },
      },
    });
    const alreadyEngaged = new Set(engagedSessions.map((s) => s.helping_peer_id));

    // Même WSM, même formule (w_i, capacity_ratio_pct) — juste réinterrogé.
    const { plan } = await selectPeers({ overflowGbps: remainingNeed });
    const candidates = plan.filter((p) => !alreadyEngaged.has(p.peer.peer_id));

    for (const candidate of candidates) {
      const peer = await Peer.findByPk(candidate.peer.peer_id);
      if (!peer || peer.status !== "ACTIVE") continue;

      await solicitPeer(attack, peer, localNodeId);
      logAudit({
        event_type: "MANUAL_OVERRIDE",
        severity: "INFO",
        actor: "system",
        target: attack.attack_id,
        description: `[Reconsidération] Pair sollicité automatiquement : ${peer.peer_name} (déclencheur : ${reason}).`,
      });
    }
  }
}

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
    const session = await solicitPeer(attack, peer, requestingNodeId, {
      direction: req.body.direction,
    });

    return res.status(201).json(session);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// POST /help/request/broadcast
router.post("/help/request/broadcast", async (req, res) => {
  try {
    if (!req.body.attack_id) {
      return res.status(400).json({ error: "attack_id is required" });
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

    // Sollicitation diffusée : un seul appel, le backend interroge lui-même
    // tous les pairs actifs de la coalition (équivalent serveur de la boucle
    // que fait le dashboard côté client).
    const peers = await Peer.findAll({
      where: { status: "ACTIVE", membership_status: { [Op.ne]: "EXPELLED" } },
    });

    // Idempotence : un second appel broadcast pour la même attaque (page
    // rechargée, double onglet, double clic) ne doit pas créer une 2e
    // session pour un pair déjà sollicité.
    const existingSessions = await HelpSession.findAll({
      where: { attack_id: attack.attack_id, direction: "OUTBOUND_REQUEST" },
    });
    const alreadySolicited = new Set(existingSessions.map((s) => s.helping_peer_id));

    const sessions = [];
    for (const peer of peers) {
      if (alreadySolicited.has(peer.peer_id)) continue;
      const session = await solicitPeer(attack, peer, requestingNodeId, {
        direction: req.body.direction,
      });
      sessions.push(session);
    }

    return res.status(201).json({ attack_id: attack.attack_id, nb_peers_solicited: sessions.length, sessions: [...existingSessions, ...sessions] });
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

    if (!localNodeId) {
      return res.status(400).json({ error: "Local node configuration is missing" });
    }

    // On the helping node, requesting_node_id must be in LOCAL_NODE_CONFIG (FK).
    // Use local node ID as FK placeholder; the actual requester is a remote peer.
    const requestingNodeId = localNodeId;

    // Créer l'attaque localement si elle vient d'un autre nœud (forwarded)
    let attack = await Attack.findByPk(req.body.attack_id);
    if (!attack) {
      if (req.body.attack_details) {
        const { attack_id: _id, createdAt, updatedAt, created_at, updated_at, ...details } = req.body.attack_details;
        attack = await Attack.create({ attack_id: req.body.attack_id, ...details });
      } else {
        return res.status(404).json({ error: "Attack not found" });
      }
    }

    // IMPORTANT : "helping_peer_id" envoyé par l'appelant correspond à
    // l'identité que LUI utilise pour désigner CE nœud (donc moi-même) —
    // jamais une entrée de pair valide ici, puisqu'un nœud ne s'enregistre
    // jamais comme son propre pair. La VRAIE autre partie de cette session
    // est "requesting_node_id" (l'identité réelle de l'appelant) : c'est
    // elle qu'il faut chercher/créer comme pair, pas helping_peer_id.
    let peer = await Peer.findByPk(req.body.requesting_node_id);
    if (!peer) {
      if (req.body.requesting_node_id) {
        peer = await Peer.create({
          peer_id:                     req.body.requesting_node_id,
          peer_name:                   req.body.requesting_node_name || `remote-${req.body.requesting_node_id.slice(0, 8)}`,
          organization_name:           req.body.requesting_node_org || "Remote Node",
          organization_type:           req.body.requesting_node_type || "UNIVERSITY",
          country_code:                "DZ",
          api_endpoint_url:            req.body.requesting_node_endpoint || "",
          public_key:                  "REMOTE_KEY",
          max_scrubbing_capacity_gbps: req.body.requesting_node_capacity ?? 0,
          declared_available_gbps:     req.body.requesting_node_capacity ?? 0,
          status:                      "ACTIVE",
        });
      } else {
        return res.status(404).json({ error: "Peer not found" });
      }
    }
    if (peer.status === "BANNED") {
      return res.status(403).json({ error: "Peer is banned" });
    }

    const sessionPayload = {
      attack_id:            req.body.attack_id,
      requesting_node_id:   requestingNodeId,
      // Convention de schéma P2P : ce champ référence "l'autre partie" de
      // la session sur CE nœud, peu importe son rôle réel (cf. contrainte
      // FK qui n'admet que LOCAL_NODE_CONFIG pour requesting_node_id).
      helping_peer_id:      peer.peer_id,
      direction:            req.body.direction || "INBOUND_OFFER",
      status:               req.body.status || "OFFERED",
      allocation_pct:       req.body.allocation_pct ?? null,
      accepted_volume_gbps: req.body.accepted_volume_gbps ?? null,
      actual_volume_gbps:   req.body.actual_volume_gbps ?? null,
      requested_at:         req.body.requested_at || new Date(),
      response_time_ms:     req.body.response_time_ms ?? null,
      tunnel_type:          req.body.tunnel_type ?? null,
      credits_exchanged:    req.body.credits_exchanged ?? 0,
    };
    // Utiliser le même session_id que le nœud demandeur pour cohérence P2P
    if (req.body.session_id) sessionPayload.session_id = req.body.session_id;

    const session = await HelpSession.create(sessionPayload);

    logMessage({ message_type: "HELP_OFFER", direction: "RECEIVED", peer_id: req.body.helping_peer_id, priority: "HIGH" });

    const requestingEndpoint = req.body.requesting_node_endpoint ?? null;
    return res.status(201).json({ ...session.toJSON(), requesting_node_endpoint: requestingEndpoint });
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

// PATCH /sessions/:id — synchronise l'état final (allocation, volume réel,
// crédits, clôture) sur la copie locale de l'aidant. La victime est seule à
// calculer ces valeurs (allocate, redirect, over) ; sans cette synchro,
// l'aidant ne voit jamais ce qu'il a fini par recevoir/livrer sur SA propre
// copie de la session.
router.patch("/sessions/:id", async (req, res) => {
  try {
    const session = await HelpSession.findByPk(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Help session not found" });
    }

    const allowed = ["status", "allocation_pct", "actual_volume_gbps", "credits_exchanged", "completed_at"];
    const updates = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    await session.update({ ...updates, updated_at: new Date() });

    return res.json(session);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// PUT /help/:id/accept
router.put("/help/:id/accept", async (req, res) => {
  try {
    const session = await HelpSession.findByPk(req.params.id);

    if (!session) {
      return res.status(404).json({ error: "Help session not found" });
    }

    const acceptableStatuses = ["REQUESTED", "OFFERED", "NEGOTIATING", "ACCEPTED"];
    if (!acceptableStatuses.includes(session.status)) {
      return res.status(409).json({ error: `Cannot accept a session in status: ${session.status}` });
    }

    const acceptedVolume  = req.body.accepted_volume_gbps ?? session.accepted_volume_gbps;
    const tunnelType      = req.body.tunnel_type ?? session.tunnel_type;
    const responseTimeMs  = req.body.response_time_ms ?? session.response_time_ms;

    await session.update({
      status:               "ACCEPTED",
      accepted_volume_gbps: acceptedVolume,
      responded_at:         req.body.responded_at || new Date(),
      tunnel_type:          tunnelType,
      response_time_ms:     responseTimeMs,
      updated_at:           new Date(),
    });

    logMessage({ message_type: "HELP_ACCEPT", direction: "SENT", peer_id: session.helping_peer_id, priority: "HIGH" });

    // Si CE nœud est le pair aidant (pas le demandeur d'origine), il vient de
    // s'engager à donner acceptedVolume — on l'enregistre tout de suite dans
    // son propre ledger (credits_given), avec la valeur qu'il connaît déjà.
    // Le nœud demandeur (direction OUTBOUND_REQUEST) ne touche pas ce champ ici :
    // sa propre comptabilité (credits_received) se fait à la clôture (POST /attack/over).
    if (session.direction !== "OUTBOUND_REQUEST" && acceptedVolume) {
      const [ledger] = await ReciprocityLedger.findOrCreate({
        where: { peer_id: session.helping_peer_id },
        defaults: { peer_id: session.helping_peer_id, credits_received: 0, credits_given: 0, balance: 0 },
      });
      await ledger.update({
        credits_given: Number(ledger.credits_given) + Number(acceptedVolume),
        balance: Number(ledger.balance) - Number(acceptedVolume),
        last_transaction_at: new Date(),
        updated_at: new Date(),
      });
    }

    // Notifier le nœud demandeur si on connaît son endpoint (pas de boucle si X-No-Callback)
    if (!req.headers["x-no-callback"] && req.body.requesting_node_endpoint) {
      try {
        await httpsClient.put(
          `${req.body.requesting_node_endpoint}/help/${session.session_id}/accept`,
          { accepted_volume_gbps: acceptedVolume, tunnel_type: tunnelType, response_time_ms: responseTimeMs },
          { headers: PEER_HEADERS({ "X-No-Callback": "true" }), timeout: 8000 }
        );
      } catch (_) { /* best-effort */ }
    }

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
      status:           "REJECTED",
      rejection_reason: req.body.rejection_reason || "Rejected by peer",
      responded_at:     req.body.responded_at || new Date(),
      updated_at:       new Date(),
    });

    logMessage({ message_type: "HELP_REJECT", direction: "SENT", peer_id: session.helping_peer_id, priority: "NORMAL" });

    if (!req.headers["x-no-callback"] && req.body.requesting_node_endpoint) {
      try {
        await httpsClient.put(
          `${req.body.requesting_node_endpoint}/help/${session.session_id}/reject`,
          { rejection_reason: req.body.rejection_reason || "Rejected by peer" },
          { headers: PEER_HEADERS({ "X-No-Callback": "true" }), timeout: 8000 }
        );
      } catch (_) { /* best-effort */ }
    }

    return res.json(session);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

/**
 * @swagger
 * /attack/{attack_id}/allocate:
 *   post:
 *     tags: [Coalition]
 *     summary: Calculer la répartition WSM parmi les pairs ayant déjà accepté
 *     description: >
 *       Étape déclenchée explicitement par le nœud victime une fois les réponses
 *       des pairs sollicités jugées suffisantes. Réutilise le même algorithme WSM
 *       (Score(p) = 0,52·C + 0,20·L + 0,20·T + 0,08·R) que la sélection initiale,
 *       mais restreint aux pairs en statut ACCEPTED pour cette attaque, en utilisant
 *       leur accepted_volume_gbps déclaré à l'acceptation comme critère de capacité.
 *     parameters:
 *       - in: path
 *         name: attack_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Plan d'allocation calculé et appliqué aux sessions ACCEPTED
 *       404:
 *         description: Attaque introuvable
 */
router.post("/attack/:id/allocate", async (req, res) => {
  try {
    const attack = await Attack.findByPk(req.params.id);
    if (!attack) {
      return res.status(404).json({ error: "Attack not found" });
    }

    const acceptedSessions = await HelpSession.findAll({
      where: { attack_id: attack.attack_id, status: "ACCEPTED" },
    });

    if (acceptedSessions.length === 0) {
      return res.json({ message: "Aucun pair n'a encore accepté", plan: [] });
    }

    const peerIds = acceptedSessions.map((s) => s.helping_peer_id);
    const capacityOverrides = {};
    acceptedSessions.forEach((s) => {
      capacityOverrides[s.helping_peer_id] = Number(s.accepted_volume_gbps ?? 0);
    });

    // Même WSM, même formule — restreint aux pairs ACCEPTED, capacité = ce
    // qu'ils ont déclaré à l'acceptation plutôt que l'ancienne valeur du heartbeat.
    const { plan } = await selectPeers({
      peerIds,
      capacityOverrides,
      overflowGbps: attack.overflow_volume_gbps ?? undefined,
    });

    // Reporter l'allocation calculée sur chaque session correspondante
    const sessionByPeer = new Map(acceptedSessions.map((s) => [s.helping_peer_id, s]));
    for (const entry of plan) {
      const session = sessionByPeer.get(entry.peer.peer_id);
      if (session) {
        await session.update({ allocation_pct: entry.allocation_pct, updated_at: new Date() });
      }
    }

    logAudit({
      event_type: "SYSTEM_CONFIG_CHANGE",
      severity: "INFO",
      actor: "system",
      target: attack.attack_id,
      description: `Allocation WSM calculée sur ${plan.length} pair(s) ayant accepté.`,
    });

    return res.json({ attack_id: attack.attack_id, plan });
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

      const peersToRecalculate = new Set();

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
        // Ce pair vient de m'aider : c'est moi qui REÇOIS des crédits de lui
        // (credits_received), pas l'inverse — utilisé par le critère Rp du WSM
        // pour favoriser les pairs qui ont déjà été généreux envers ce nœud.
        await ledger.update({
          credits_received: ledger.credits_received + volume,
          balance: ledger.balance + volume,
          last_transaction_at: new Date(),
          updated_at: new Date(),
        });

        peersToRecalculate.add(session.helping_peer_id);
      }

      // Déclencher recalcul PeerTrust pour chaque pair impliqué (DS3)
      for (const peer_id of peersToRecalculate) {
        recalculateAndSave(peer_id).catch(() => {});
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

    // Chaque pair réel sollicité a sa PROPRE copie locale de cette attaque
    // (créée lors du transfert de /help/offer) — rien ne la ferme
    // automatiquement de son côté. On notifie chaque pair réel impliqué pour
    // que son bandeau "Attaque en cours" se mette aussi à jour. Best-effort :
    // un pair injoignable ne bloque pas la clôture côté victime.
    const involvedSessions = await HelpSession.findAll({
      where: { attack_id: req.body.attack_id },
      include: [{ model: Peer, as: "helping_peer" }],
    });
    const notifiedEndpoints = new Set();
    for (const s of involvedSessions) {
      const ep = s.helping_peer?.api_endpoint_url;
      if (!ep || ep.includes(".shieldnet.local")) continue;

      // Synchroniser SA propre copie de cette session (allocation, volume
      // réel, crédits, statut final) — sans ça, l'aidant ne voit jamais ce
      // qu'il a réellement reçu/livré sur son propre historique de sessions.
      httpsClient
        .patch(`${ep}/sessions/${s.session_id}`, {
          status: s.status,
          allocation_pct: s.allocation_pct,
          actual_volume_gbps: s.actual_volume_gbps,
          credits_exchanged: s.credits_exchanged,
          completed_at: s.completed_at,
        }, { headers: PEER_HEADERS(), timeout: 5000 })
        .catch(() => {});

      if (notifiedEndpoints.has(ep)) continue;
      notifiedEndpoints.add(ep);
      httpsClient
        .patch(`${ep}/attacks/${req.body.attack_id}`, {
          status: "ENDED",
          ended_at: req.body.timestamp || new Date(),
        }, { headers: PEER_HEADERS(), timeout: 5000 })
        .catch(() => {});
    }

    return res.json({ ...attack.toJSON(), total_filtered_gbps: totalFiltered });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

module.exports = router;
module.exports.reconsiderCoalition = reconsiderCoalition;
