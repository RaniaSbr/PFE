const fs = require("fs");
const https = require("https");

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  run().catch((error) => {
    console.error(error.message || String(error));
    process.exit(1);
  });
});

async function run() {
  const payload = JSON.parse(input || "{}");
  const url = new URL(payload.url);
  const body =
    payload.body === null || payload.body === undefined
      ? null
      : JSON.stringify(payload.body);

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method: payload.method || "GET",
    headers: {
      ...(payload.headers || {}),
    },
    cert: fs.readFileSync(payload.certPath),
    key: fs.readFileSync(payload.keyPath),
    ca: fs.readFileSync(payload.caPath),
    rejectUnauthorized: false,
  };

  if (body !== null) {
    options.headers["Content-Type"] = "application/json";
    options.headers["Content-Length"] = Buffer.byteLength(body);
  }

  const response = await request(options, body);
  if (response.statusCode >= 400) {
    throw new Error(`HTTP ${response.statusCode}: ${response.body}`);
  }

  process.stdout.write(response.body || "null");
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode, body: data });
      });
    });

    req.on("error", reject);

    if (body !== null) {
      req.write(body);
    }

    req.end();
  });
}
