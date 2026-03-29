require("dotenv").config();
const app = require("./app");
const { initDatabase } = require("./models");

const PORT = process.env.API_PORT || process.env.NODE_PORT || 3001;
const NODE_ID = process.env.NODE_ID || "unknown";
const HOST = process.env.HOST || "0.0.0.0";

async function start() {
  try {
    await initDatabase();

    app.listen(PORT, HOST, () => {
      console.log("=".repeat(50));
      console.log(`  ShieldNet Node: ${NODE_ID}`);
      console.log(`  Host: ${HOST}`);
      console.log(`  Port: ${PORT}`);
      console.log(`  API: http://localhost:${PORT}/api/v1`);
      console.log("=".repeat(50));
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
