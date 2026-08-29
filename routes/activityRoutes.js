const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { WRITE_ROLES } = require("../middlewares/roleMiddleware");
const {
  logEmployeeActivity,
  listActivitiesForClient,
  listActivitiesForLead,
} = require("../services/employeeActivityService");

const router = express.Router();

router.post("/log", authMiddleware, async (req, res) => {
  try {
    const { clientId, leadId, channel, note, requirementUpdates } = req.body || {};

    const result = await logEmployeeActivity({
      userId: req.user._id,
      clientId,
      leadId,
      channel: channel || "phone",
      note,
      requirementUpdates,
      ipAddress: req.ip,
      req,
    });

    if (result.error === "invalid_input") {
      return res.status(400).json({ success: false, message: result.message });
    }
    if (result.error === "not_found") {
      return res.status(404).json({ success: false, message: result.message });
    }

    return res.status(201).json({
      success: true,
      message: result.requirementsChanged
        ? "Activity logged — requirements updated and matching re-triggered"
        : "Activity logged",
      activity: result.activity,
      requirementsChanged: result.requirementsChanged,
      parsedUpdates: result.parsedUpdates,
      appliedUpdates: result.appliedUpdates,
    });
  } catch (err) {
    console.error("[activity] log failed:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/client/:clientId", authMiddleware, async (req, res) => {
  try {
    const activities = await listActivitiesForClient(req.params.clientId);
    return res.json({ success: true, activities });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/lead/:leadId", authMiddleware, async (req, res) => {
  try {
    const activities = await listActivitiesForLead(req.params.leadId);
    return res.json({ success: true, activities });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
