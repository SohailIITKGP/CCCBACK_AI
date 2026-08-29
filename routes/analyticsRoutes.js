const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRoles, ADMIN_ROLES } = require("../middlewares/roleMiddleware");
const { getOverrideAnalytics } = require("../services/overrideAnalyticsService");
const { getPreferenceAnalytics } = require("../services/clientPreferenceMemoryService");

const router = express.Router();

router.get(
  "/overrides",
  authMiddleware,
  requireRoles(...ADMIN_ROLES, "Lead-Employee", "BO-Client"),
  async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days, 10) || 90, 365);
      const analytics = await getOverrideAnalytics({ days });
      return res.json({ success: true, analytics });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

router.get(
  "/preferences",
  authMiddleware,
  requireRoles(...ADMIN_ROLES, "Lead-Employee", "BO-Client"),
  async (req, res) => {
    try {
      const days = Math.min(parseInt(req.query.days, 10) || 90, 365);
      const analytics = await getPreferenceAnalytics({ days });
      return res.json({ success: true, analytics });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
