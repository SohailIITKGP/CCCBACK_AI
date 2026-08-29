const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRoles, ADMIN_ROLES } = require("../middlewares/roleMiddleware");
const settingsController = require("../controllers/settingsController");

router.use(authMiddleware, requireRoles(...ADMIN_ROLES));

router.get("/reminders", settingsController.getReminderSettings);
router.put("/reminders", settingsController.updateReminderSettings);

module.exports = router;
