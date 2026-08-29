const AppSettings = require("../models/AppSettings");
const Opportunity = require("../models/Opportunity");
const { REMINDER_SCHEDULES } = require("./opportunityReminderService");
const { getLeadDueReminderCount } = require("./leadReminderService");

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const normalizeDailyTime = (value) => {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  return TIME_PATTERN.test(trimmed) ? trimmed : null;
};

const timeToCron = (dailyTime) => {
  const [hour, minute] = dailyTime.split(":").map(Number);
  return `${minute} ${hour} * * *`;
};

const getDueReminderCount = async () => {
  const now = new Date();
  const trackedStatuses = Object.keys(REMINDER_SCHEDULES);
  return Opportunity.countDocuments({
    isVisibility: true,
    "reminderState.completed": { $ne: true },
    "reminderState.status": { $in: trackedStatuses },
    "reminderState.nextReminderAt": { $ne: null, $lte: now },
  });
};

const getReminderSettings = async () => {
  const doc = await AppSettings.getSingleton();
  return doc.reminders;
};

const getReminderSettingsPayload = async () => {
  const doc = await AppSettings.getSingleton();
  await doc.populate("reminders.lastRunBy", "name email role");
  const [dueOpportunityCount, dueLeadCount] = await Promise.all([
    getDueReminderCount(),
    getLeadDueReminderCount(),
  ]);

  return {
    dailyTime: doc.reminders.dailyTime || "09:00",
    autoEnabled: Boolean(doc.reminders.autoEnabled),
    lastRunAt: doc.reminders.lastRunAt,
    lastRunBy: doc.reminders.lastRunBy,
    lastRunResult: doc.reminders.lastRunResult || {
      dispatched: 0,
      skipped: 0,
      total: 0,
    },
    dueCount: dueOpportunityCount + dueLeadCount,
    dueOpportunityCount,
    dueLeadCount,
    timezone: "Asia/Kolkata",
  };
};

const updateReminderSettings = async ({ dailyTime, autoEnabled }) => {
  const doc = await AppSettings.getSingleton();

  if (dailyTime !== undefined) {
    const normalized = normalizeDailyTime(dailyTime);
    if (!normalized) {
      throw new Error("dailyTime must be HH:mm in 24-hour format");
    }
    doc.reminders.dailyTime = normalized;
  }

  if (autoEnabled !== undefined) {
    doc.reminders.autoEnabled = Boolean(autoEnabled);
  }

  await doc.save();
  return doc.reminders;
};

const recordReminderRun = async (userId, result) => {
  const doc = await AppSettings.getSingleton();
  doc.reminders.lastRunAt = new Date();
  doc.reminders.lastRunBy = userId;
  doc.reminders.lastRunResult = {
    dispatched: result.dispatched || 0,
    skipped: result.skipped || 0,
    total: result.total || 0,
  };
  await doc.save();
};

module.exports = {
  normalizeDailyTime,
  timeToCron,
  getDueReminderCount,
  getLeadDueReminderCount,
  getReminderSettings,
  getReminderSettingsPayload,
  updateReminderSettings,
  recordReminderRun,
};
