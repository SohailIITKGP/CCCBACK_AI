const express = require("express");
const {
  createLead,
  convertToClient,
  getAllLeads,
  getLeadById,
  updateLead,
  deleteLead,
  getleademployeee,
  asignleademployee,
  updateStatus,
  getAllLeadsClosed,
  getLeadDuplicates,
  mergeLeads,

} = require("../controllers/leadController");
const { submitPublicLead } = require("../controllers/publicLeadController");
const { createLimiter } = require("../middlewares/rateLimiter");

const oppController = require("../controllers/oppController");
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRoles, ADMIN_ROLES } = require("../middlewares/roleMiddleware");
const Lead = require("../models/Lead");
const {
  runLeadReminderSweep,
  LEAD_REMINDER_SCHEDULES,
} = require("../services/leadReminderService");
const { recordReminderRun, getLeadDueReminderCount } = require("../services/reminderSettingsService");
const router = express.Router();

// Public lead intake (website form) — rate limited, no auth
router.post("/public", createLimiter, submitPublicLead);

// Create a new lead
router.post("/add", authMiddleware, createLead);

// Get all leads
router.get("/",authMiddleware, getAllLeads);

// Single lead (fresh remarks / email-parsed fields)
router.get("/detail/:id", authMiddleware, getLeadById);

// Convert a lead to a client
router.post("/:id/convert-to-client",authMiddleware, convertToClient);

router.get("/:id/duplicates", authMiddleware, getLeadDuplicates);
router.post("/merge", authMiddleware, mergeLeads);

// Update a lead
router.put("/update/:id", authMiddleware, updateLead);

// Delete a lead
router.delete("/delete/:id", authMiddleware, deleteLead);

router.get("/getleademployeee", authMiddleware, getleademployeee);

router.put("/asignleademployee/:leadId", authMiddleware, asignleademployee);
router.put("/updateStatus/:id",   authMiddleware,  updateStatus);
router.get("/getAllLeadsClosed", authMiddleware, getAllLeadsClosed);

router.get(
  "/reminders/preview",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const now = new Date();
      const trackedStatuses = Object.keys(LEAD_REMINDER_SCHEDULES);
      const due = await Lead.find({
        isConverted: { $ne: true },
        "reminderState.completed": { $ne: true },
        "reminderState.status": { $in: trackedStatuses },
        "reminderState.nextReminderAt": { $ne: null, $lte: now },
      })
        .select("name status contactNumber email reminderState assignedTo")
        .lean();

      return res.status(200).json({
        success: true,
        now,
        count: due.length,
        schedules: LEAD_REMINDER_SCHEDULES,
        leads: due.map((l) => ({
          _id: l._id,
          name: l.name,
          status: l.status,
          reminderState: l.reminderState,
        })),
      });
    } catch (error) {
      console.error("Error previewing lead reminders:", error);
      return res.status(500).json({ success: false, message: "Failed to preview lead reminders" });
    }
  }
);

router.post(
  "/reminders/run",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const result = await runLeadReminderSweep();
      await recordReminderRun(req.user._id, result, "lead");
      const dueCount = await getLeadDueReminderCount();
      return res.status(200).json({
        success: true,
        ...result,
        dueCount,
        message: `Sent ${result.dispatched} lead reminder(s). In-app notifications created.`,
      });
    } catch (error) {
      console.error("Error running lead reminder sweep:", error);
      return res.status(500).json({ success: false, message: "Failed to run lead reminder sweep" });
    }
  }
);



router.get("/calender", authMiddleware, oppController.calender);
router.put("/markEventAsDone/:opportunityId/:commentId/:eventType", oppController.markEventAsDone);
 


module.exports = router;
