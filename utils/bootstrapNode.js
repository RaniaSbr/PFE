const fs = require("fs");
const { LocalNodeConfig, PolicyConfig, ScrubbingCapability } = require("../models");

async function bootstrapLocalNode() {
  const existing = await LocalNodeConfig.findOne();
  if (existing) {
    console.log(`[Bootstrap] Nœud déjà configuré : ${existing.node_name} (${existing.node_id})`);
    return existing;
  }

  const nodeId   = process.env.NODE_ID || "unknown-node";
  const apiPort  = Number(process.env.API_PORT || 8443);
  const certPath = process.env.TLS_CERT;
  const publicKey = certPath && fs.existsSync(certPath)
    ? fs.readFileSync(certPath, "utf8")
    : `NO_CERT_${nodeId}`;

  const node = await LocalNodeConfig.create({
    node_name: process.env.NODE_NAME || nodeId,
    organization_name: process.env.ORGANIZATION_NAME || nodeId,
    organization_type: process.env.ORGANIZATION_TYPE || "OTHER",
    country_code: process.env.COUNTRY_CODE || "DZ",
    ip_range_protected: process.env.IP_RANGE || null,
    api_endpoint_url: `https://${nodeId}:${apiPort}/api/v1`,
    api_port: apiPort,
    public_key: publicKey,
    max_scrubbing_capacity_gbps: Number(process.env.MAX_CAPACITY_GBPS || 0),
    current_load_percent: Number(process.env.CURRENT_LOAD_PERCENT || 0),
    status: "ACTIVE",
    coalition_join_date: new Date(),
    last_updated: new Date(),
  });

  await PolicyConfig.create({
    node_id: node.node_id,
    min_trust_score_to_help: 0.70,
    max_capacity_share_pct: 70,
    heartbeat_interval_sec: Number(process.env.HEARTBEAT_INTERVAL_MS || 30000) / 1000,
    auto_offer_enabled: true,
    is_current: true,
  });

  await ScrubbingCapability.create({
    node_id: node.node_id,
    max_capacity_gbps: node.max_scrubbing_capacity_gbps,
    filtering_accuracy: 0.95,
    is_active: true,
  });

  console.log(`[Bootstrap] Nœud initialisé depuis .env : ${node.node_name} (${node.node_id})`);
  return node;
}

module.exports = { bootstrapLocalNode };
