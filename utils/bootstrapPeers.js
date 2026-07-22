const fs = require("fs");
const path = require("path");
const { Peer } = require("../models");

/**
 * Topologie statique de la coalition de démo — reflète les .env.* de chaque nœud.
 * Si tu changes un .env.*, mets aussi à jour l'entrée correspondante ici.
 */
const COALITION = [
  { node_id: "node-university", cert: "university", org: "ESI Alger",          type: "UNIVERSITY", capacity: 2.0 },
  { node_id: "node-pme",        cert: "pme",        org: "PME Tech SARL",       type: "PME",        capacity: 0.5 },
  { node_id: "node-isp",        cert: "isp",        org: "ISP Algeria",        type: "ISP",        capacity: 5.0 },
  { node_id: "node-datacenter", cert: "datacenter", org: "DataCenter Algeria", type: "DATACENTER", capacity: 10.0 },
];

function readCert(certFolder) {
  const p = path.join(__dirname, "..", "certs", certFolder, "node.crt");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : `NO_CERT_${certFolder}`;
}

/**
 * Enregistre les 3 autres nœuds de la coalition comme pairs au démarrage.
 * Idempotent : ignore les pairs déjà enregistrés (par peer_name).
 */
async function bootstrapPeers() {
  const selfId = process.env.NODE_ID;
  const others = COALITION.filter((n) => n.node_id !== selfId);

  for (const peer of others) {
    const existing = await Peer.findOne({ where: { peer_name: peer.node_id } });
    if (existing) continue;

    await Peer.create({
      peer_name: peer.node_id,
      organization_name: peer.org,
      organization_type: peer.type,
      country_code: "DZ",
      api_endpoint_url: `https://${peer.node_id}:8443/api/v1`,
      public_key: readCert(peer.cert),
      max_scrubbing_capacity_gbps: peer.capacity,
      declared_available_gbps: Number((peer.capacity * 0.8).toFixed(2)),
      status: "ACTIVE",
      membership_status: "CONFIRMED",
      relationship_type: "KNOWN_PEER",
      first_seen: new Date(),
    });
    console.log(`[Bootstrap] Pair enregistré automatiquement : ${peer.node_id}`);
  }
}

module.exports = { bootstrapPeers };
