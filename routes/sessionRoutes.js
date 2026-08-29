const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const sessionController = require("../controllers/sessionController");

// All routes require authentication
router.use(authMiddleware);

// Get all active sessions (Admin only)
router.get("/active", sessionController.getAllActiveSessions);

// Get sessions for a specific user
router.get("/user/:userId", sessionController.getUserSessions);

// Terminate a specific session (Admin only)
router.post("/terminate/:sessionId", sessionController.terminateSession);

// Terminate all sessions for a user (Admin only)
router.post("/terminate-user/:userId", sessionController.terminateAllUserSessions);

// Get audit logs (Super Admin only)
router.get("/audit-logs/export", sessionController.exportAuditLogs);
router.get("/audit-logs/record", sessionController.getRecordAuditHistory);
router.get("/audit-summary", sessionController.getAuditSummary);
router.get("/audit-employee-summary", sessionController.getAuditEmployeeSummary);
router.get("/audit-leaderboard", sessionController.getAuditLeaderboard);
router.get("/audit-logs", sessionController.getAuditLogs);

// Get login statistics (Admin only)
router.get("/statistics", sessionController.getLoginStatistics);

module.exports = router;

