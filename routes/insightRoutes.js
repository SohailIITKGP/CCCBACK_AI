const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const {
  getLatestInsight,
  getInsightHistory,
  generateInsight,
  getAtRiskOpportunities,
  runScheduledWeekly,
} = require("../controllers/insightController");

router.get("/latest", authMiddleware, getLatestInsight);
router.get("/history", authMiddleware, getInsightHistory);
router.get("/at-risk", authMiddleware, getAtRiskOpportunities);
router.post("/generate", authMiddleware, generateInsight);
router.post("/run-weekly", authMiddleware, runScheduledWeekly);

module.exports = router;
