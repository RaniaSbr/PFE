const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const app = express();

// Middleware globaux
app.use(helmet());
app.use(cors());
app.use(morgan("short"));
app.use(express.json({ limit: "1mb" }));

// Routes — chaque fichier gère un groupe d'endpoints
const discoveryRoutes = require("./routes/discovery");
const capacityRoutes = require("./routes/capacity");
const coalitionRoutes = require("./routes/coalition");
const trustRoutes = require("./routes/trust");
const monitoringRoutes = require("./routes/monitoring");
const simulationRoutes = require("./routes/simulation");

// Montage : tout commence par /api/v1
app.use("/api/v1", discoveryRoutes);
app.use("/api/v1", capacityRoutes);
app.use("/api/v1", coalitionRoutes);
app.use("/api/v1", trustRoutes);
app.use("/api/v1", monitoringRoutes);
app.use("/api/v1", simulationRoutes);

// Route racine
app.get("/", (req, res) => {
  res.json({
    name: "ShieldNet Node",
    node_id: process.env.NODE_ID,
    version: "1.0.0",
    api: "/api/v1",
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Erreur globale
app.use((err, req, res, next) => {
  console.error("[ERROR]", err.message);
  res.status(500).json({ error: "Internal server error" });
});
 
module.exports = app;
