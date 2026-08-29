const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRoles, ADMIN_ROLES } = require("../middlewares/roleMiddleware");
const journeyProjectionService = require("../services/journeyProjectionService");
const journeySummaryService = require("../services/journeySummaryService");
const { getJourneyEvents } = require("../services/eventService");

const router = express.Router();

router.get(
  "/:correlationId",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const view = await journeyProjectionService.getJourneyView(req.params.correlationId);
      if (!view) {
        return res.status(404).json({ success: false, message: "Journey not found" });
      }
      return res.status(200).json({ success: true, journey: view });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get(
  "/:correlationId/events",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const events = await getJourneyEvents(req.params.correlationId);
      return res.status(200).json({ success: true, count: events.length, events });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get(
  "/:correlationId/summary",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const summary = await journeySummaryService.summarizeJourney(req.params.correlationId);
      return res.status(200).json({ success: true, ...summary });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

module.exports = router;
