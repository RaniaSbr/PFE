require("dotenv").config();
const fs = require("fs");
const http = require("http");
const https = require("https");
const app = require("./app");
const { initDatabase } = require("./models");

const PORT = process.env.API_PORT || process.env.NODE_PORT || 8443;
const HOST = process.env.HOST || "0.0.0.0";
const NODE_ID = process.env.NODE_ID || "unknown";
const MTLS_ENABLED = process.env.MTLS_ENABLED === "true";

const heartbeatSender = require("./utils/heartbeatSender");

/**
 * Charge les certificats TLS si disponibles.
 * Retourne null si les fichiers sont absents (mode HTTP).
 */
function loadCertificates() {
  const certPath = process.env.TLS_CERT || "./certs/node.crt";
  const keyPath  = process.env.TLS_KEY  || "./certs/node.key";
  const caPath   = process.env.TLS_CA   || "./certs/ca.crt";

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    return null;
  }

  const tlsOptions = {
    cert: fs.readFileSync(certPath),
    key:  fs.readFileSync(keyPath),
  };

  // mTLS : exiger un certificat client signé par la CA de la coalition
  if (MTLS_ENABLED && fs.existsSync(caPath)) {
    tlsOptions.ca = fs.readFileSync(caPath);
    tlsOptions.requestCert      = true;   // demander le certificat client
    tlsOptions.rejectUnauthorized = true; // refuser tout cert non signé par la CA coalition
  }

  return tlsOptions;
}

async function start() {
  try {
    await initDatabase();

    const tlsOptions = loadCertificates();
    let server;
    let protocol;

    if (tlsOptions) {
      server = https.createServer(tlsOptions, app);
      protocol = MTLS_ENABLED ? "HTTPS + mTLS" : "HTTPS";
    } else {
      server = http.createServer(app);
      protocol = "HTTP (no certs found — run scripts/generate-certs.sh for TLS)";
    }

    server.listen(PORT, HOST, () => {
      console.log("=".repeat(50));
      console.log(`  ShieldNet Node: ${NODE_ID}`);
      console.log(`  Host: ${HOST}`);
      console.log(`  Port: ${PORT}`);
      console.log(`  Protocol: ${protocol}`);
      console.log(`  API: http://localhost:${PORT}/api/v1`);
      console.log(`  Auth: POST /api/v1/auth/token`);
      console.log(`  Docs: http://localhost:${PORT}/api-docs`);
      console.log("=".repeat(50));

      // Démarrer l'envoi automatique de heartbeats aux pairs (mTLS + JWT RS256)
      heartbeatSender.start();
    });
  } catch (error) {
    console.error("[FATAL]", error.message || error.name || "Unknown startup error");
    if (error.parent && error.parent.code) {
      console.error("[DB_CODE]", error.parent.code);
    }
    process.exit(1);
  }
}

start();
