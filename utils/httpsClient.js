/**
 * utils/httpsClient.js
 * Client HTTPS mTLS pour les communications inter-nœuds ShieldNet.
 *
 * Chaque requête sortante présente :
 *   - Le certificat du nœud local  (TLS_CERT → node.crt)
 *   - La clé privée du nœud local  (TLS_KEY  → node.key)
 *   - Le certificat CA coalition   (TLS_CA   → ca.crt)
 *
 * Le nœud récepteur peut ainsi vérifier l'identité du nœud appelant
 * → authentification mutuelle réelle (true mTLS).
 */

"use strict";

const fs    = require("fs");
const https = require("https");
const http  = require("http");

// ─── Cache des agents (un seul agent mTLS réutilisé) ────────────────────────
let _mtlsAgent = null;
let _plainAgent = null;

/**
 * Construit (ou retourne en cache) un https.Agent configuré pour mTLS.
 * Présente le certificat client à chaque connexion sortante.
 */
function getMtlsAgent() {
  if (_mtlsAgent) return _mtlsAgent;

  const certPath = process.env.TLS_CERT || "./certs/node.crt";
  const keyPath  = process.env.TLS_KEY  || "./certs/node.key";
  const caPath   = process.env.TLS_CA   || "./certs/ca.crt";

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath) || !fs.existsSync(caPath)) {
    console.warn("[mTLS-Client] Certificats introuvables — utilisation HTTP sans mTLS");
    return null;
  }

  _mtlsAgent = new https.Agent({
    cert: fs.readFileSync(certPath),   // certificat du nœud local → prouve l'identité
    key:  fs.readFileSync(keyPath),    // clé privée → signe le handshake TLS
    ca:   fs.readFileSync(caPath),     // CA coalition → vérifie le certificat du serveur
    rejectUnauthorized: true,          // refuser tout certificat non signé par notre CA
    keepAlive: true,
  });

  console.log("[mTLS-Client] Agent mTLS initialisé avec certificat client");
  return _mtlsAgent;
}

/**
 * Effectue une requête HTTP/HTTPS vers un pair.
 *
 * @param {string} url         URL complète (https://node-isp:8443/api/v1/...)
 * @param {object} options     Options de la requête
 * @param {string} options.method        GET | POST | PUT | DELETE (défaut: GET)
 * @param {object} [options.headers]     En-têtes additionnels
 * @param {object|string} [options.body] Corps de la requête (sérialisé en JSON si objet)
 * @param {string} [options.token]       JWT Bearer token (ajouté à Authorization)
 * @param {number} [options.timeout]     Timeout en ms (défaut: 5000)
 *
 * @returns {Promise<{status: number, data: any}>}
 */
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const {
      method  = "GET",
      headers = {},
      body    = null,
      token   = null,
      timeout = 5000,
    } = options;

    const isHttps = url.startsWith("https://");
    const agent   = isHttps ? getMtlsAgent() : undefined;

    const bodyStr = body
      ? (typeof body === "string" ? body : JSON.stringify(body))
      : null;

    const reqHeaders = {
      "Content-Type": "application/json",
      "Accept":       "application/json",
      ...headers,
    };

    if (token) {
      reqHeaders["Authorization"] = `Bearer ${token}`;
    }

    if (bodyStr) {
      reqHeaders["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (isHttps ? 443 : 80),
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   method.toUpperCase(),
      headers:  reqHeaders,
      agent,                 // ← agent mTLS avec certificat client
      timeout,
    };

    const lib = isHttps ? https : http;
    const req = lib.request(reqOptions, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        resolve({ status: res.statusCode, data });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`Request timeout after ${timeout}ms`));
    });

    req.on("error", (err) => {
      // Enrichir le message d'erreur pour faciliter le debug mTLS
      if (err.code === "ECONNREFUSED") {
        reject(new Error(`[mTLS] Connexion refusée vers ${url}`));
      } else if (err.code === "CERT_HAS_EXPIRED") {
        reject(new Error(`[mTLS] Certificat expiré pour ${url}`));
      } else if (err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
        reject(new Error(`[mTLS] Certificat non signé par la CA coalition : ${url}`));
      } else if (err.code === "ERR_SSL_PEER_CERT_REQUEST") {
        reject(new Error(`[mTLS] Le serveur exige un certificat client : ${url}`));
      } else {
        reject(err);
      }
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Raccourcis ──────────────────────────────────────────────────────────────

const get  = (url, opts = {}) => request(url, { ...opts, method: "GET"  });
const post = (url, body, opts = {}) => request(url, { ...opts, method: "POST", body });
const put  = (url, body, opts = {}) => request(url, { ...opts, method: "PUT",  body });

module.exports = { request, get, post, put, getMtlsAgent };
