/**
 * Lead nurturing reminder service – mirrors opportunityReminderService.
 */

const Lead = require("../models/Lead");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { getEmailFrom, sendMailSafe } = require("../utils/smtpTransporter");

const DAY_MS = 24 * 60 * 60 * 1000;

const LEAD_REMINDER_SCHEDULES = Object.freeze({
  "No Response After Multiple Attempts": {
    intervals: [7],
    repeating: true,
    label: "No Response",
  },
  "Expansion Currently On Hold": {
    intervals: [7, 7, 7],
    repeating: false,
    label: "Expansion On Hold",
  },
  "No Expansion Planned in West Zone": {
    intervals: [7],
    repeating: true,
    label: "No West Zone Expansion",
  },
  "Looking for Franchise Investor": {
    intervals: [7],
    repeating: true,
    label: "Franchise Investor",
  },
  "Not the Right Decision Maker": {
    intervals: [7],
    repeating: true,
    label: "Wrong Decision Maker",
  },
  "Company Profile Shared for Evaluation": {
    intervals: [3, 3, 7],
    repeating: false,
    label: "Profile Under Evaluation",
  },
});

const isLeadReminderTrackedStatus = (status) =>
  Boolean(status && LEAD_REMINDER_SCHEDULES[status]);

const computeNextReminderAt = (state) => {
  if (!state || !state.status) return null;
  const schedule = LEAD_REMINDER_SCHEDULES[state.status];
  if (!schedule) return null;

  const sent = state.remindersSent || 0;
  const { intervals, repeating } = schedule;

  let intervalDays;
  if (sent < intervals.length) {
    intervalDays = intervals[sent];
  } else if (repeating) {
    intervalDays = intervals[intervals.length - 1];
  } else {
    return null;
  }

  const anchor =
    sent === 0
      ? state.statusSetAt || new Date()
      : state.lastReminderAt || state.statusSetAt || new Date();

  return new Date(new Date(anchor).getTime() + intervalDays * DAY_MS);
};

const buildReminderStateForStatus = (status, now = new Date()) => {
  if (!isLeadReminderTrackedStatus(status)) {
    return {
      status,
      statusSetAt: now,
      remindersSent: 0,
      lastReminderAt: null,
      nextReminderAt: null,
      completed: true,
    };
  }

  const base = {
    status,
    statusSetAt: now,
    remindersSent: 0,
    lastReminderAt: null,
    completed: false,
  };
  base.nextReminderAt = computeNextReminderAt(base);
  return base;
};

const escapeHtml = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const computeAllReminderDueDates = (state) => {
  if (!state || !state.status) return [];
  const schedule = LEAD_REMINDER_SCHEDULES[state.status];
  if (!schedule) return [];

  const anchor = new Date(state.statusSetAt || new Date());
  const results = [];

  if (schedule.repeating) {
    const intervalDays = schedule.intervals[0];
    const slots = Math.max((state.remindersSent || 0) + 3, 3);
    let cursor = anchor;
    for (let n = 1; n <= slots; n += 1) {
      cursor = new Date(cursor.getTime() + intervalDays * DAY_MS);
      results.push({ reminderNumber: n, dueDate: new Date(cursor) });
    }
    return results;
  }

  let cursor = anchor;
  for (let i = 0; i < schedule.intervals.length; i += 1) {
    cursor = new Date(cursor.getTime() + schedule.intervals[i] * DAY_MS);
    results.push({ reminderNumber: i + 1, dueDate: new Date(cursor) });
  }
  return results;
};

const formatScheduleCadence = (schedule) => {
  if (!schedule) return "";
  if (schedule.repeating) {
    return `every ${schedule.intervals[0]} days (repeating)`;
  }
  const parts = schedule.intervals.map((d, i) => (i === 0 ? `${d}d` : `+${d}d`));
  return `${parts.join(" → ")} (${schedule.intervals.length} reminders)`;
};

const getScheduleBehaviour = (schedule) => {
  if (!schedule) return "";
  if (schedule.repeating) return "repeating forever";
  return `${schedule.intervals.length} reminders, then stops`;
};

const getLeadReminderSchedulesForUI = () =>
  Object.entries(LEAD_REMINDER_SCHEDULES).map(([status, schedule]) => ({
    status,
    label: schedule.label,
    cadence: formatScheduleCadence(schedule),
    behaviour: getScheduleBehaviour(schedule),
    intervals: schedule.intervals,
    repeating: Boolean(schedule.repeating),
  }));

const buildReminderContent = (lead, reminderNumber) => {
  const schedule = LEAD_REMINDER_SCHEDULES[lead.reminderState.status];
  const label = schedule ? schedule.label : lead.reminderState.status;
  const leadName = lead.name || "Lead";

  const subject = `Lead Reminder #${reminderNumber} – ${label}: ${leadName}`;
  const inAppMessage = `Lead reminder #${reminderNumber} – ${label}. Lead "${leadName}" needs nurturing follow-up.`;

  const html = `
    <div style="font-family: Arial, sans-serif; padding: 16px; max-width: 640px;">
      <h2 style="margin:0 0 12px 0;">Lead Nurturing Reminder #${reminderNumber}</h2>
      <p style="margin:0 0 12px 0;">
        Lead is in status <strong>${escapeHtml(lead.reminderState.status)}</strong> and is due for follow-up.
      </p>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #e0e0e0;">
        <tr><td><strong>Lead</strong></td><td>${escapeHtml(leadName)}</td></tr>
        <tr><td><strong>Contact</strong></td><td>${escapeHtml(lead.contactNumber || "—")}</td></tr>
        <tr><td><strong>Email</strong></td><td>${escapeHtml(lead.email || "—")}</td></tr>
        <tr><td><strong>State</strong></td><td>${escapeHtml(lead.state || "—")}</td></tr>
        <tr><td><strong>Status</strong></td><td>${escapeHtml(lead.reminderState.status)}</td></tr>
        <tr><td><strong>Status set on</strong></td><td>${escapeHtml(
          new Date(lead.reminderState.statusSetAt).toLocaleString()
        )}</td></tr>
        <tr><td><strong>Reminder #</strong></td><td>${reminderNumber}</td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:12px;color:#666;">
        Internal reminder for assigned lead owner and management team.
      </p>
    </div>
  `;

  return { subject, html, inAppMessage };
};

const resolveRecipients = async (lead) => {
  const ids = new Set();
  const recipients = [];

  const push = (user) => {
    if (!user || !user._id) return;
    const key = user._id.toString();
    if (ids.has(key)) return;
    if (!user.email) return;
    if (user.status && user.status !== "Active") return;
    ids.add(key);
    recipients.push(user);
  };

  if (lead.assignedTo) {
    const assignee = await User.findById(lead.assignedTo)
      .select("name email role status")
      .lean();
    push(assignee);
  }

  if (lead.createdBy) {
    const creator = await User.findById(lead.createdBy)
      .select("name email role status")
      .lean();
    push(creator);
  }

  const admins = await User.find({
    role: { $in: ["Super Admin", "Manager"] },
    status: "Active",
  })
    .select("name email role status")
    .lean();

  admins.forEach(push);
  return recipients;
};

const persistInAppNotifications = async (lead, recipients, content, reminderNumber) => {
  if (recipients.length === 0) return;
  const docs = recipients.map((user) => ({
    recipientUserId: user._id,
    category: "lead_reminder",
    type: "Lead",
    action: "Reminder",
    entityId: lead._id,
    entityName: lead.name || "Lead",
    message: content.inAppMessage,
    severity: reminderNumber >= 3 ? "warning" : "info",
    meta: {
      status: lead.reminderState.status,
      reminderNumber,
    },
  }));
  try {
    await Notification.insertMany(docs, { ordered: false });
  } catch (err) {
    console.error("[leadReminderService] Failed to persist notifications:", err.message);
  }
};

const sendEmail = async (recipients, content) => {
  const bccList = recipients.map((u) => u.email).filter(Boolean);
  if (bccList.length === 0) return;

  const from = getEmailFrom();
  if (!from) return;

  await sendMailSafe({
    from,
    to: from,
    bcc: bccList,
    subject: content.subject,
    html: content.html,
  });
};

const dispatchReminder = async (lead, reminderNumber) => {
  const recipients = await resolveRecipients(lead);
  if (recipients.length === 0) {
    console.warn(`[leadReminderService] No recipients for lead ${lead._id}`);
    return { dispatched: false, recipientCount: 0 };
  }

  const content = buildReminderContent(lead, reminderNumber);

  await Promise.allSettled([
    persistInAppNotifications(lead, recipients, content, reminderNumber),
    sendEmail(recipients, content),
    (async () => {
      try {
        const { markLeadReminderEmailSent } = require("./followUpTaskService");
        await markLeadReminderEmailSent(lead, reminderNumber);
      } catch (err) {
        console.error("[leadReminderService] Failed to update lead task:", err.message);
      }
    })(),
  ]);

  return { dispatched: true, recipientCount: recipients.length };
};

const advanceReminderState = async (leadId, currentReminderState) => {
  const now = new Date();
  const nextSent = (currentReminderState.remindersSent || 0) + 1;

  const newState = {
    ...currentReminderState.toObject?.() || currentReminderState,
    remindersSent: nextSent,
    lastReminderAt: now,
  };
  newState.nextReminderAt = computeNextReminderAt(newState);
  newState.completed = newState.nextReminderAt === null;

  return Lead.updateOne(
    {
      _id: leadId,
      "reminderState.status": currentReminderState.status,
      "reminderState.remindersSent": currentReminderState.remindersSent || 0,
    },
    {
      $set: {
        "reminderState.remindersSent": newState.remindersSent,
        "reminderState.lastReminderAt": newState.lastReminderAt,
        "reminderState.nextReminderAt": newState.nextReminderAt,
        "reminderState.completed": newState.completed,
      },
    }
  );
};

const runLeadReminderSweep = async () => {
  const now = new Date();
  const trackedStatuses = Object.keys(LEAD_REMINDER_SCHEDULES);

  const dueLeads = await Lead.find({
    isConverted: { $ne: true },
    "reminderState.completed": { $ne: true },
    "reminderState.status": { $in: trackedStatuses },
    "reminderState.nextReminderAt": { $ne: null, $lte: now },
  })
    .populate("assignedTo", "name email")
    .populate("createdBy", "name email");

  let dispatched = 0;
  let skipped = 0;

  for (const lead of dueLeads) {
    try {
      if (!isLeadReminderTrackedStatus(lead.reminderState?.status)) {
        skipped += 1;
        continue;
      }

      const reminderNumber = (lead.reminderState.remindersSent || 0) + 1;
      const result = await dispatchReminder(lead, reminderNumber);
      if (!result.dispatched) {
        skipped += 1;
        continue;
      }

      const update = await advanceReminderState(lead._id, lead.reminderState);
      if (update.modifiedCount === 0) {
        skipped += 1;
        continue;
      }

      try {
        const refreshed = await Lead.findById(lead._id)
          .populate("assignedTo", "name email")
          .populate("createdBy", "name email");
        if (refreshed) {
          const { regenerateLeadReminderScheduleTasks } = require("./followUpTaskService");
          await regenerateLeadReminderScheduleTasks(refreshed);
        }
      } catch (err) {
        console.error("[leadReminderService] Failed to refresh lead tasks:", err.message);
      }

      dispatched += 1;
    } catch (err) {
      console.error(`[leadReminderService] Failure for lead ${lead._id}:`, err.message);
    }
  }

  console.log(
    `[leadReminderService] Sweep complete – dispatched=${dispatched} skipped=${skipped} candidates=${dueLeads.length}`
  );
  return { dispatched, skipped, total: dueLeads.length };
};

const fireImmediateLeadReminderIfDue = async (leadId) => {
  const lead = await Lead.findById(leadId)
    .populate("assignedTo", "name email")
    .populate("createdBy", "name email");

  if (!lead || lead.isConverted) return;
  if (!isLeadReminderTrackedStatus(lead.reminderState?.status)) return;
  if (lead.reminderState.completed) return;
  if (
    !lead.reminderState.nextReminderAt ||
    lead.reminderState.nextReminderAt > new Date()
  )
    return;

  const reminderNumber = (lead.reminderState.remindersSent || 0) + 1;
  const result = await dispatchReminder(lead, reminderNumber);
  if (result.dispatched) {
    await advanceReminderState(lead._id, lead.reminderState);
    try {
      const refreshed = await Lead.findById(leadId)
        .populate("assignedTo", "name email")
        .populate("createdBy", "name email");
      if (refreshed) {
        const { regenerateLeadReminderScheduleTasks } = require("./followUpTaskService");
        await regenerateLeadReminderScheduleTasks(refreshed);
      }
    } catch (err) {
      console.error("[leadReminderService] Failed to refresh lead tasks:", err.message);
    }
  }
};

const getLeadDueReminderCount = async () => {
  const now = new Date();
  const trackedStatuses = Object.keys(LEAD_REMINDER_SCHEDULES);
  return Lead.countDocuments({
    isConverted: { $ne: true },
    "reminderState.completed": { $ne: true },
    "reminderState.status": { $in: trackedStatuses },
    "reminderState.nextReminderAt": { $ne: null, $lte: now },
  });
};

module.exports = {
  LEAD_REMINDER_SCHEDULES,
  isLeadReminderTrackedStatus,
  computeNextReminderAt,
  computeAllReminderDueDates,
  formatScheduleCadence,
  getLeadReminderSchedulesForUI,
  buildReminderContent,
  buildReminderStateForStatus,
  runLeadReminderSweep,
  fireImmediateLeadReminderIfDue,
  getLeadDueReminderCount,
};
