const express = require("express");
const { LocalNodeConfig, ScrubbingCapability } = require("../models");

const router = express.Router();

router.get("/capacity", async (req, res) => {
  try {
    const node = await LocalNodeConfig.findOne({
      include: [
        {
          model: ScrubbingCapability,
          as: "scrubbing_capabilities",
        },
      ],
    });

    if (!node) {
      return res.status(404).json({ error: "Local node configuration not found" });
    }

    const maxCapacity = Number(node.max_scrubbing_capacity_gbps || 0);
    const loadPercent = Number(node.current_load_percent || 0);
    const availableGbps = Math.max(0, maxCapacity * (1 - loadPercent / 100));

    return res.json({
      node_id: node.node_id,
      status: node.status,
      current_load_percent: loadPercent,
      max_scrubbing_capacity_gbps: maxCapacity,
      available_gbps: Number(availableGbps.toFixed(2)),
      capabilities: node.scrubbing_capabilities,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
