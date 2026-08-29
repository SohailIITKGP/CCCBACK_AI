const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRoles, ADMIN_ROLES } = require("../middlewares/roleMiddleware");
const followUpTaskController = require("../controllers/followUpTaskController");

const TASK_VIEW_ROLES = [
  "Super Admin",
  "Manager",
  "BO-Client",
  "Lead-Employee",
  "Product-Manager",
  "BO-Lead",
  "FE-Property",
];

router.use(authMiddleware, requireRoles(...TASK_VIEW_ROLES));

router.get("/summary", followUpTaskController.getSummary);
router.get("/schedules", followUpTaskController.getReminderSchedules);
router.get("/filter-options", followUpTaskController.getFilterOptions);
router.get(
  "/reports/employees",
  requireRoles(...ADMIN_ROLES),
  followUpTaskController.getEmployeeReports
);
router.post(
  "/sync",
  requireRoles(...ADMIN_ROLES),
  followUpTaskController.syncFromOpportunities
);
router.get("/", followUpTaskController.listTasks);
router.get("/:id", followUpTaskController.getTaskDetail);
router.put("/:id/complete", followUpTaskController.completeTask);
router.put("/:id/start", followUpTaskController.startTask);
router.put("/:id/reschedule", followUpTaskController.rescheduleTask);

module.exports = router;
