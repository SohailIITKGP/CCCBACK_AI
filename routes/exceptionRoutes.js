const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRoles, ADMIN_ROLES } = require("../middlewares/roleMiddleware");
const {
  listExceptions,
  getExceptionSummary,
  resolveException,
  dismissException,
  assignException,
} = require("../services/exceptionCenterService");
const { EXCEPTION_TYPES } = require("../config/exceptionTypes");

const router = express.Router();

const EXCEPTION_ROLES = [
  "Super Admin",
  "Manager",
  "Lead-Employee",
  "FE-Property",
  "BO-Client",
  "Product-Manager",
];

router.get(
  "/summary",
  authMiddleware,
  requireRoles(...EXCEPTION_ROLES),
  async (req, res) => {
    try {
      const role = req.user.role === "Super Admin" ? null : req.user.role;
      const summary = await getExceptionSummary(role);
      return res.json({ success: true, summary, types: EXCEPTION_TYPES });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

router.get(
  "/",
  authMiddleware,
  requireRoles(...EXCEPTION_ROLES),
  async (req, res) => {
    try {
      const { status = "open", type, correlationId, limit, skip, ownerRole } = req.query;
      const userRole = req.user.role;
      const result = await listExceptions({
        status,
        type,
        correlationId,
        limit: Math.min(parseInt(limit, 10) || 50, 100),
        skip: parseInt(skip, 10) || 0,
        ownerRole: userRole === "Super Admin" ? ownerRole : null,
        userRole,
      });
      return res.json({ success: true, ...result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

router.post(
  "/:exceptionId/resolve",
  authMiddleware,
  requireRoles(...ADMIN_ROLES, "Lead-Employee", "FE-Property", "BO-Client"),
  async (req, res) => {
    try {
      const doc = await resolveException(req.params.exceptionId, req.user._id, req.body?.resolution);
      if (!doc) {
        return res.status(404).json({ success: false, message: "Exception not found or already closed" });
      }
      return res.json({ success: true, exception: doc });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

router.post(
  "/:exceptionId/dismiss",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const doc = await dismissException(req.params.exceptionId, req.user._id, req.body?.resolution);
      if (!doc) {
        return res.status(404).json({ success: false, message: "Exception not found or already closed" });
      }
      return res.json({ success: true, exception: doc });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

router.post(
  "/:exceptionId/assign",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const { assigneeId } = req.body || {};
      if (!assigneeId) {
        return res.status(400).json({ success: false, message: "assigneeId required" });
      }
      const doc = await assignException(req.params.exceptionId, assigneeId);
      if (!doc) {
        return res.status(404).json({ success: false, message: "Exception not found" });
      }
      return res.json({ success: true, exception: doc });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

router.post(
  "/digest/run",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const { sendDailyExceptionDigest } = require("../services/exceptionDigestService");
      const result = await sendDailyExceptionDigest();
      return res.json({ success: true, result });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
