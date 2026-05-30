const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./config/swagger");
const { jwtMiddleware, mtlsMiddleware } = require("./middleware/auth");

const app = express();

// Middleware globaux
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan("short"));
app.use(express.json({ limit: "1mb" }));

// mTLS — vérification du certificat client (si MTLS_ENABLED=true)
app.use(mtlsMiddleware);

// Routes publiques (avant JWT)
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/dashboard", (req, res) => {
  res.sendFile(path.resolve(__dirname, "dashboard.html"));
});
app.get("/scalability.png", (req, res) => {
  res.sendFile(path.resolve(__dirname, "tests", "shieldnet_scalability.png"));
});

// JWT — authentification de toutes les routes protégées
app.use(jwtMiddleware);

// Routes
const authRoutes = require("./routes/auth");
const discoveryRoutes = require("./routes/discovery");
const capacityRoutes = require("./routes/capacity");
const coalitionRoutes = require("./routes/coalition");
const trustRoutes = require("./routes/trust");
const monitoringRoutes = require("./routes/monitoring");
const simulationRoutes = require("./routes/simulation");

// Montage des routes API
app.use("/api/v1", authRoutes);
app.use("/api/v1", discoveryRoutes);
app.use("/api/v1", capacityRoutes);
app.use("/api/v1", coalitionRoutes);
app.use("/api/v1", trustRoutes);
app.use("/api/v1", monitoringRoutes);
app.use("/api/v1", simulationRoutes);

// Route racine (publique)
app.get("/", (req, res) => {
  res.json({
    name: "ShieldNet Node",
    node_id: process.env.NODE_ID,
    version: "1.0.0",
    api: "/api/v1",
    auth: "POST /api/v1/auth/token",
    docs: "/api-docs",
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
