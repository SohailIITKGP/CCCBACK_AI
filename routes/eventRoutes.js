const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRoles, ADMIN_ROLES } = require("../middlewares/roleMiddleware");
const {
  getJourneyEvents,
  getRecentEvents,
} = require("../services/eventService");
const { replayFailedOutbox } = require("../services/outboxService");
const OutboxEvent = require("../models/OutboxEvent");
const AgentLog = require("../models/AgentLog");
const { isOrchestrationEnabled } = require("../config/orchestration");

const router = express.Router();

router.get(
  "/status",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  (req, res) => {
    res.json({
      success: true,
      orchestrationEnabled: isOrchestrationEnabled(),
      redisConfigured: Boolean(process.env.REDIS_URL),
    });
  }
);

router.get(
  "/journey/:correlationId",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const events = await getJourneyEvents(req.params.correlationId);
      return res.status(200).json({
        success: true,
        correlationId: req.params.correlationId,
        count: events.length,
        events,
      });
    } catch (error) {
      console.error("[events] journey fetch failed:", error.message);
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get(
  "/recent",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 50;
      const events = await getRecentEvents(limit);
      return res.status(200).json({
        success: true,
        count: events.length,
        events,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get(
  "/logs/recent",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const logs = await AgentLog.find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return res.status(200).json({ success: true, count: logs.length, logs });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get(
  "/outbox/pending",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const pending = await OutboxEvent.find({ status: "pending" })
        .sort({ createdAt: 1 })
        .limit(100)
        .lean();
      const failed = await OutboxEvent.find({ status: "failed" })
        .sort({ updatedAt: -1 })
        .limit(50)
        .lean();
      return res.status(200).json({
        success: true,
        pendingCount: pending.length,
        failedCount: failed.length,
        pending,
        failed,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/outbox/replay/:outboxId",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const record = await replayFailedOutbox(req.params.outboxId);
      return res.status(200).json({
        success: true,
        message: "Outbox record reset to pending",
        outbox: record,
      });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }
);

module.exports = router;
