/**
 * Opportunity reminder service.
 *
 * Owns the schedule table + the dispatcher that:
 *   1. Persists an in-app Notification document per recipient.
 *   2. Sends a single batched email (BCC) to all recipients.
 *   3. Fires a best-effort FCM push (failures never block the pipeline).
 *
 * The schedule is keyed by opportunity status; intervals are days FROM the
 * previous trigger (statusSetAt for reminder #1, lastReminderAt afterwards).
 *
 * Statuses not present in REMINDER_SCHEDULES are explicitly skipped – we do
 * NOT want to spam users for terminal states (Win/Reject/Agreement/LOI/etc).
 */

const mongoose = require("mongoose");
const {
  getSmtpTransporter,
  getEmailFrom,
  withTimeout,
  EMAIL_SEND_TIMEOUT_MS,
} = require("../utils/smtpTransporter");

const Opportunity = require("../models/Opportunity");
const Notification = require("../models/Notification");
const User = require("../models/User");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * intervals[i] = days between the (i)th trigger and the (i+1)th reminder.
 * intervals[0]  -> from statusSetAt to reminder #1
 * intervals[1]  -> from reminder #1 to reminder #2
 * ...
 *
 * `repeating: true` reuses the LAST interval forever (used for "Pending").
 */
const REMINDER_SCHEDULES = Object.freeze({
  Pending: { intervals: [2], repeating: true, label: "Pending" },

  "In Evaluation": {
    intervals: [7, 3, 3],
    repeating: false,
    label: "In Evaluation",
  },

  "Planning for Site Visit": {
    intervals: [7, 5, 5],
    repeating: false,
    label: "Planning for Site Visit",
  },

  "Property Approved but Board Approval Pending": {
    intervals: [7, 4, 4],
    repeating: false,
    label: "Board Approval Pending",
  },

  "Keep this option on Hold": {
    intervals: [7, 7, 7],
    repeating: false,
    label: "On Hold",
  },

  // Same-day reminder. Multiple status spellings exist in the codebase – we
  // intentionally cover the documented "Site Visit Done" variants only.
  "Site Visit Done": { intervals: [0], repeating: false, label: "Site Visit Done" },
  "Site Visit Done - Looks Positive": {
    intervals: [0],
    repeating: false,
    label: "Site Visit Done",
  },
});

const isReminderTrackedStatus = (status) =>
  Boolean(status && REMINDER_SCHEDULES[status]);

/**
 * Compute the next reminder timestamp for a given reminderState.
 * Returns null when the schedule is exhausted.
 */
const computeNextReminderAt = (state) => {
  if (!state || !state.status) return null;
  const schedule = REMINDER_SCHEDULES[state.status];
  if (!schedule) return null;

  const sent = state.remindersSent || 0;
  const { intervals, repeating } = schedule;

  let intervalDays;
  if (sent < intervals.length) {
    intervalDays = intervals[sent];
  } else if (repeating) {
    intervalDays = intervals[intervals.length - 1];
  } else {
    return null; // schedule complete
  }

  const anchor =
    sent === 0
      ? state.statusSetAt || new Date()
      : state.lastReminderAt || state.statusSetAt || new Date();

  return new Date(new Date(anchor).getTime() + intervalDays * DAY_MS);
};

/**
 * Build (or rebuild) reminderState for a given status. Called whenever
 * status changes on an opportunity.
 */
const buildReminderStateForStatus = (status, now = new Date()) => {
  if (!isReminderTrackedStatus(status)) {
    return {
      status,
      statusSetAt: now,
      remindersSent: 0,
      lastReminderAt: null,
      nextReminderAt: null,
      completed: true, // nothing to do
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

const parseFromAddress = getEmailFrom;

/* -------------------------------------------------------------------------- */
/*  Recipients                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Returns a de-duplicated list of users who should receive a reminder for
 * this opportunity. We intentionally keep this conservative:
 *  - the opportunity owner (whoLinkthis)
 *  - the property creator
 *  - all Active Super Admins & Managers
 *
 * NEVER include the client themselves – reminders are internal.
 */
const resolveRecipients = async (opportunity) => {
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

  if (opportunity.whoLinkthis) {
    const owner = await User.findById(opportunity.whoLinkthis)
      .select("name email role status")
      .lean();
    push(owner);
  }

  if (opportunity.property && opportunity.property.whoCreated) {
    const creator = await User.findById(opportunity.property.whoCreated)
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

/* -------------------------------------------------------------------------- */
/*  Content                                                                   */
/* -------------------------------------------------------------------------- */

const escapeHtml = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const buildReminderContent = (opportunity, reminderNumber) => {
  const schedule = REMINDER_SCHEDULES[opportunity.reminderState.status];
  const label = schedule ? schedule.label : opportunity.reminderState.status;
  const clientName = opportunity.client?.name || "Client";
  const propertyName = opportunity.property?.name || "Property";
  const propertyAddress = opportunity.property?.address || "";

  const subject = `Reminder #${reminderNumber} – ${label}: ${clientName} / ${propertyName}`;

  const inAppMessage = `Reminder #${reminderNumber} – ${label}. Opportunity ${clientName} → ${propertyName} needs attention.`;

  const html = `
    <div style="font-family: Arial, sans-serif; padding: 16px; max-width: 640px;">
      <h2 style="margin:0 0 12px 0;">Opportunity Reminder #${reminderNumber}</h2>
      <p style="margin:0 0 12px 0;">
        The opportunity below is in status
        <strong>${escapeHtml(opportunity.reminderState.status)}</strong>
        and is due for a follow-up.
      </p>
      <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #e0e0e0;">
        <tr><td><strong>Client</strong></td><td>${escapeHtml(clientName)}</td></tr>
        <tr><td><strong>Property</strong></td><td>${escapeHtml(propertyName)}</td></tr>
        <tr><td><strong>Address</strong></td><td>${escapeHtml(propertyAddress)}</td></tr>
        <tr><td><strong>Status</strong></td><td>${escapeHtml(opportunity.reminderState.status)}</td></tr>
        <tr><td><strong>Status set on</strong></td><td>${escapeHtml(
          new Date(opportunity.reminderState.statusSetAt).toLocaleString()
        )}</td></tr>
        <tr><td><strong>Reminder #</strong></td><td>${reminderNumber}</td></tr>
      </table>
      <p style="margin-top:16px;">
        Please log in to the CRM to update this opportunity.
      </p>
      <p style="color:#666;font-size:12px;margin-top:24px;">
        You are receiving this email because you are assigned to this opportunity
        or are part of the management team. This is an automated reminder.
      </p>
    </div>
  `;

  return { subject, html, inAppMessage };
};

/** All reminder due dates for a status (used to pre-create task schedule). */
const computeAllReminderDueDates = (state) => {
  if (!state || !state.status) return [];
  const schedule = REMINDER_SCHEDULES[state.status];
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
  if (schedule.intervals.length === 1 && schedule.intervals[0] === 0) {
    return "1 reminder, same day on status change";
  }
  return `${schedule.intervals.length} reminders, then stops`;
};

const getReminderSchedulesForUI = () =>
  Object.entries(REMINDER_SCHEDULES).map(([status, schedule]) => ({
    status,
    label: schedule.label,
    cadence: formatScheduleCadence(schedule),
    behaviour: getScheduleBehaviour(schedule),
    intervals: schedule.intervals,
    repeating: Boolean(schedule.repeating),
  }));

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                  */
/* -------------------------------------------------------------------------- */

const persistInAppNotifications = async (opportunity, recipients, content, reminderNumber) => {
  if (recipients.length === 0) return;
  const docs = recipients.map((user) => ({
    recipientUserId: user._id,
    category: "opportunity_reminder",
    type: "Opportunity",
    action: "Reminder",
    entityId: opportunity._id,
    entityName: opportunity.client?.name || "Opportunity",
    opportunityId: opportunity._id,
    message: content.inAppMessage,
    severity: reminderNumber >= 3 ? "warning" : "info",
    meta: {
      status: opportunity.reminderState.status,
      reminderNumber,
    },
  }));
  try {
    await Notification.insertMany(docs, { ordered: false });
  } catch (err) {
    console.error("[reminderService] Failed to persist in-app notifications:", err.message);
  }
};

const sendEmail = async (recipients, content) => {
  const transporter = getSmtpTransporter();
  if (!transporter) return;

  const bccList = recipients.map((u) => u.email).filter(Boolean);
  if (bccList.length === 0) return;

  const from = parseFromAddress();
  if (!from) {
    console.warn("[reminderService] No EMAIL_FROM resolvable – skipping email.");
    return;
  }

  try {
    await withTimeout(
      transporter.sendMail({
        from,
        to: from, // visible "to" – BCC keeps individual recipients private
        bcc: bccList,
        subject: content.subject,
        html: content.html,
      }),
      EMAIL_SEND_TIMEOUT_MS,
      "Gmail sendMail"
    );
  } catch (err) {
    console.error(
      "[reminderService] Failed to send reminder email:",
      err.message
    );
  }
};

/**
 * Dispatch a single reminder for an opportunity. Caller is responsible for
 * advancing reminderState afterwards (so the dispatch + persistence stay
 * atomic per reminder).
 *
 * Channels: in-app Notification rows + email. Push has been intentionally
 * dropped from this codebase.
 */
const dispatchReminder = async (opportunity, reminderNumber) => {
  const recipients = await resolveRecipients(opportunity);
  if (recipients.length === 0) {
    console.warn(
      `[reminderService] No recipients for opportunity ${opportunity._id} – skipping dispatch`
    );
    return { dispatched: false, recipientCount: 0 };
  }

  const content = buildReminderContent(opportunity, reminderNumber);

  // Run channels in parallel but isolate failures.
  await Promise.allSettled([
    persistInAppNotifications(opportunity, recipients, content, reminderNumber),
    sendEmail(recipients, content),
    (async () => {
      try {
        const { markReminderEmailSent, regenerateReminderScheduleTasks } = require("./followUpTaskService");
        await markReminderEmailSent(opportunity, reminderNumber);
        await regenerateReminderScheduleTasks(opportunity);
      } catch (err) {
        console.error("[reminderService] Failed to update follow-up task:", err.message);
      }
    })(),
  ]);

  return { dispatched: true, recipientCount: recipients.length };
};

/* -------------------------------------------------------------------------- */
/*  Cron entry points                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Atomically advance reminderState after a successful dispatch. We use a
 * conditional update (matching the current remindersSent count) to avoid
 * double-sending in case the cron overlaps a manual status change.
 */
const advanceReminderState = async (opportunityId, currentReminderState) => {
  const now = new Date();
  const nextSent = (currentReminderState.remindersSent || 0) + 1;

  const newState = {
    ...currentReminderState.toObject?.() || currentReminderState,
    remindersSent: nextSent,
    lastReminderAt: now,
  };
  newState.nextReminderAt = computeNextReminderAt(newState);
  newState.completed = newState.nextReminderAt === null;

  return Opportunity.updateOne(
    {
      _id: opportunityId,
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

/**
 * Run a single sweep over all opportunities whose reminder is due. Designed
 * to be idempotent and safe to call manually (admin tooling / testing).
 */
const runReminderSweep = async () => {
  const now = new Date();
  const startedAt = Date.now();

  const trackedStatuses = Object.keys(REMINDER_SCHEDULES);

  const dueOpportunities = await Opportunity.find({
    isVisibility: true,
    "reminderState.completed": { $ne: true },
    "reminderState.status": { $in: trackedStatuses },
    "reminderState.nextReminderAt": { $ne: null, $lte: now },
  })
    .populate("client", "name email phone")
    .populate({
      path: "property",
      select: "name address whoCreated owner contact",
    });

  let dispatched = 0;
  let skipped = 0;

  for (const opportunity of dueOpportunities) {
    try {
      // Re-validate before dispatching: status may have changed since query.
      if (!isReminderTrackedStatus(opportunity.reminderState?.status)) {
        skipped += 1;
        continue;
      }

      const reminderNumber = (opportunity.reminderState.remindersSent || 0) + 1;
      const result = await dispatchReminder(opportunity, reminderNumber);
      if (!result.dispatched) {
        skipped += 1;
        continue;
      }

      const update = await advanceReminderState(
        opportunity._id,
        opportunity.reminderState
      );
      if (update.modifiedCount === 0) {
        // Lost a race – another worker advanced state. Safe to skip.
        skipped += 1;
        continue;
      }
      try {
        const refreshed = await Opportunity.findById(opportunity._id)
          .populate("client", "name email phone")
          .populate({ path: "property", select: "name address whoCreated" })
          .populate("whoLinkthis", "name email");
        if (refreshed) {
          const { regenerateReminderScheduleTasks } = require("./followUpTaskService");
          await regenerateReminderScheduleTasks(refreshed);
        }
      } catch (err) {
        console.error("[reminderService] Failed to refresh reminder tasks:", err.message);
      }
      dispatched += 1;
    } catch (err) {
      console.error(
        `[reminderService] Failure processing opportunity ${opportunity._id}:`,
        err.message
      );
    }
  }

  console.log(
    `[reminderService] Sweep complete in ${Date.now() - startedAt}ms – dispatched=${dispatched} skipped=${skipped} candidates=${dueOpportunities.length}`
  );
  return { dispatched, skipped, total: dueOpportunities.length };
};

/**
 * Fire one reminder immediately for the current state – used by "Site Visit
 * Done" where the schedule starts with a 0-day reminder, so we don't want to
 * wait for the next cron sweep.
 */
const fireImmediateReminderIfDue = async (opportunityId) => {
  const opportunity = await Opportunity.findById(opportunityId)
    .populate("client", "name email phone")
    .populate({
      path: "property",
      select: "name address whoCreated owner contact",
    });

  if (!opportunity) return;
  if (!opportunity.isVisibility) return;
  if (!isReminderTrackedStatus(opportunity.reminderState?.status)) return;
  if (opportunity.reminderState.completed) return;
  if (
    !opportunity.reminderState.nextReminderAt ||
    opportunity.reminderState.nextReminderAt > new Date()
  )
    return;

  const reminderNumber = (opportunity.reminderState.remindersSent || 0) + 1;
  const result = await dispatchReminder(opportunity, reminderNumber);
  if (result.dispatched) {
    await advanceReminderState(opportunity._id, opportunity.reminderState);
    try {
      const refreshed = await Opportunity.findById(opportunityId)
        .populate("client", "name email phone")
        .populate({ path: "property", select: "name address whoCreated" })
        .populate("whoLinkthis", "name email");
      if (refreshed) {
        const { regenerateReminderScheduleTasks } = require("./followUpTaskService");
        await regenerateReminderScheduleTasks(refreshed);
      }
    } catch (err) {
      console.error("[reminderService] Failed to refresh reminder tasks:", err.message);
    }
  }
};

module.exports = {
  REMINDER_SCHEDULES,
  isReminderTrackedStatus,
  computeNextReminderAt,
  computeAllReminderDueDates,
  formatScheduleCadence,
  getReminderSchedulesForUI,
  buildReminderContent,
  buildReminderStateForStatus,
  runReminderSweep,
  fireImmediateReminderIfDue,
};
