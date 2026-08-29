const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRoles, ADMIN_ROLES } = require("../middlewares/roleMiddleware");
const agentActionService = require("../services/agentActionService");
const propertyMatchingService = require("../services/propertyMatchingService");
const AgentAction = require("../models/AgentAction");
const { resumeAi } = require("../services/aiPauseService");
const { enqueueOutboxEvent } = require("../services/outboxService");
const { getControlCenterSummary } = require("../services/agentControlCenterService");
const agentActionExecutionService = require("../services/agentActionExecutionService");
const {
  getAutomationSettings,
  updateAutomationSettings,
} = require("../services/agentAutomationService");

const router = express.Router();

router.get(
  "/control-center",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const summary = await getControlCenterSummary();
      return res.status(200).json({ success: true, ...summary });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get(
  "/automation",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const automation = await getAutomationSettings(true);
      return res.status(200).json({ success: true, automation });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.patch(
  "/automation",
  authMiddleware,
  requireRoles("Super Admin"),
  async (req, res) => {
    try {
      const automation = await updateAutomationSettings(req.body || {}, req.user._id);
      return res.status(200).json({
        success: true,
        message: "Automation settings saved",
        automation,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/actions/batch-approve",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const summary = await agentActionExecutionService.batchApproveActions(req.user._id);
      return res.status(200).json({
        success: true,
        message: `Approved ${summary.approved} of ${summary.total} (emails + property matches)`,
        summary,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get(
  "/matching/client/:clientId",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const pending = await AgentAction.findOne({
        entityType: "Client",
        entityId: req.params.clientId,
        intent: "suggest_properties",
        status: "pending_approval",
      }).lean();

      const preview = await propertyMatchingService.matchPropertiesForClient(
        req.params.clientId
      );

      return res.status(200).json({
        success: true,
        pendingAction: pending,
        preview: preview.matches || [],
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get(
  "/actions/pending",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const actions = await agentActionService.listPending({
        limit: parseInt(req.query.limit, 10) || 50,
      });
      return res.status(200).json({ success: true, count: actions.length, actions });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get(
  "/actions/:id",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const action = await agentActionService.getById(req.params.id);
      if (!action) {
        return res.status(404).json({ success: false, message: "Action not found" });
      }
      return res.status(200).json({ success: true, action });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/actions/:id/approve",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const action = await agentActionService.getById(req.params.id);
      if (!action) {
        return res.status(404).json({ success: false, message: "Action not found" });
      }
      if (action.status !== "pending_approval") {
        return res.status(400).json({
          success: false,
          message: `Action is not pending (status: ${action.status})`,
        });
      }

      let exec = await agentActionExecutionService.executeAction(action, req.user._id);

      if (exec.error) {
        return res.status(400).json({
          success: false,
          message: exec.error,
          reason: exec.reason || exec.message,
        });
      }

      const successMessage =
        action.intent === "suggest_properties"
          ? "Property linked and opportunity created"
          : action.intent === "propose_site_visit"
            ? "Site visit scheduled"
            : "Action approved and executed";

      return res.status(200).json({
        success: true,
        message: successMessage,
        actionId: req.params.id,
        execution: exec,
      });
    } catch (error) {
      console.error("[agents] approve failed:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/actions/:id/reject",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const result = await agentActionService.reject(
        req.params.id,
        req.user._id,
        req.body?.reason || ""
      );

      if (result.error === "not_found") {
        return res.status(404).json({ success: false, message: "Action not found" });
      }
      if (result.error === "invalid_status") {
        return res.status(400).json({
          success: false,
          message: `Action is not pending (status: ${result.action.status})`,
        });
      }

      await enqueueOutboxEvent({
        eventType: "agent.action_rejected",
        aggregateType: "AgentAction",
        aggregateId: result.action._id,
        correlationId: result.action.correlationId,
        schemaVersion: 1,
        metadata: { actor: "user", actorId: req.user._id },
        payload: {
          agentActionId: result.action._id.toString(),
          correlationId: result.action.correlationId,
          reason: result.action.rejectionReason,
        },
      });

      return res.status(200).json({
        success: true,
        message: "Action rejected",
        action: result.action,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/journey/:correlationId/resume-ai",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      await resumeAi(req.params.correlationId);
      return res.status(200).json({
        success: true,
        message: "AI automation resumed for this journey",
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

module.exports = router;