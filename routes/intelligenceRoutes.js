const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRoles, ADMIN_ROLES } = require("../middlewares/roleMiddleware");
const {
  getIntelligenceMetrics,
  runIntelligenceBatch,
} = require("../services/intelligenceBatchService");
const ruleProposalService = require("../services/ruleProposalService");
const ruleConfigService = require("../services/ruleConfigService");

const router = express.Router();

router.get(
  "/metrics",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const days = parseInt(req.query.days, 10) || 90;
      const metrics = await getIntelligenceMetrics(days);
      return res.status(200).json({ success: true, metrics });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get(
  "/config",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const config = await ruleConfigService.getActiveConfig();
      return res.status(200).json({ success: true, config });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.get(
  "/proposals",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const status = req.query.status || "pending";
      const proposals = await ruleProposalService.listProposals({
        status,
        limit: parseInt(req.query.limit, 10) || 50,
      });
      return res.status(200).json({ success: true, count: proposals.length, proposals });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/batch/run",
  authMiddleware,
  requireRoles("Super Admin"),
  async (req, res) => {
    try {
      const result = await runIntelligenceBatch();
      return res.status(200).json({ success: true, result });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/proposals/:id/approve",
  authMiddleware,
  requireRoles("Super Admin"),
  async (req, res) => {
    try {
      const result = await ruleProposalService.approveProposal(req.params.id, req.user._id);
      if (result.error === "not_found") {
        return res.status(404).json({ success: false, message: "Proposal not found" });
      }
      if (result.error === "not_pending") {
        return res.status(400).json({ success: false, message: "Proposal is not pending" });
      }
      return res.status(200).json({
        success: true,
        message: "Rule change applied",
        proposal: result.proposal,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

router.post(
  "/proposals/:id/reject",
  authMiddleware,
  requireRoles("Super Admin"),
  async (req, res) => {
    try {
      const result = await ruleProposalService.rejectProposal(
        req.params.id,
        req.user._id,
        req.body?.reason || ""
      );
      if (result.error === "not_found") {
        return res.status(404).json({ success: false, message: "Proposal not found" });
      }
      if (result.error === "not_pending") {
        return res.status(400).json({ success: false, message: "Proposal is not pending" });
      }
      return res.status(200).json({ success: true, proposal: result.proposal });
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message });
    }
  }
);

module.exports = router;
