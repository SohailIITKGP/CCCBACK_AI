const {
  getReminderSettingsPayload,
  updateReminderSettings,
} = require("../services/reminderSettingsService");
const { rescheduleReminderJob } = require("../services/scheduledJobs");

exports.getReminderSettings = async (req, res) => {
  try {
    const settings = await getReminderSettingsPayload();
    return res.status(200).json({ success: true, settings });
  } catch (error) {
    console.error("[settings] getReminderSettings failed:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load reminder settings",
    });
  }
};

exports.updateReminderSettings = async (req, res) => {
  try {
    const { dailyTime, autoEnabled } = req.body || {};
    await updateReminderSettings({ dailyTime, autoEnabled });
    await rescheduleReminderJob();

    const settings = await getReminderSettingsPayload();
    return res.status(200).json({
      success: true,
      message: "Reminder settings updated",
      settings,
    });
  } catch (error) {
    console.error("[settings] updateReminderSettings failed:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to update reminder settings",
    });
  }
};
