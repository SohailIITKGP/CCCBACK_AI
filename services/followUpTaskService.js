/**
 * Follow-up task service – creates and queries employee tasks from:
 *   • automated opportunity reminders (email + in-app)
 *   • manually scheduled follow-ups / site visits on opportunities
 */

const FollowUpTask = require("../models/FollowUpTask");
const Opportunity = require("../models/Opportunity");
const Lead = require("../models/Lead");
const User = require("../models/User");
const {
  REMINDER_SCHEDULES,
  computeAllReminderDueDates,
  formatScheduleCadence,
  buildReminderContent,
} = require("./opportunityReminderService");
const {
  LEAD_REMINDER_SCHEDULES,
  computeAllReminderDueDates: computeLeadReminderDueDates,
  formatScheduleCadence: formatLeadScheduleCadence,
  buildReminderContent: buildLeadReminderContent,
} = require("./leadReminderService");
const {
  deriveTaskTiming,
  computeCompletionFields,
  formatDelayDays,
  formatDurationMs,
  OPEN_STATUSES,
} = require("../utils/taskTiming");
const {
  recordTaskActivity,
  listTaskActivities,
} = require("./taskActivityService");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const startOfDayIST = (date = new Date()) => {
  const utcMs = date.getTime() + IST_OFFSET_MS;
  const istDay = new Date(utcMs);
  istDay.setUTCHours(0, 0, 0, 0);
  return new Date(istDay.getTime() - IST_OFFSET_MS);
};

const endOfDayIST = (date = new Date()) => {
  const start = startOfDayIST(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
};

const buildSourceKey = (parts) => parts.filter(Boolean).join(":");

/** Stable epoch for the current status cycle — changes whenever status is reset. */
const getReminderStatusEpoch = (reminderState) =>
  reminderState?.statusSetAt
    ? new Date(reminderState.statusSetAt).getTime()
    : 0;

const buildOpportunityReminderSourceKey = (opportunity, reminderNumber, assigneeId) => {
  const rs = opportunity.reminderState || {};
  return buildSourceKey([
    "reminder",
    opportunity._id.toString(),
    rs.status || "",
    getReminderStatusEpoch(rs),
    reminderNumber,
    assigneeId.toString(),
  ]);
};

const buildLeadReminderSourceKey = (lead, reminderNumber, assigneeId) => {
  const rs = lead.reminderState || {};
  return buildSourceKey([
    "lead-reminder",
    lead._id.toString(),
    rs.status || "",
    getReminderStatusEpoch(rs),
    reminderNumber,
    assigneeId.toString(),
  ]);
};

/**
 * Drop pending reminder tasks from a previous status cycle.
 * Called before regenerating the schedule after a status change.
 */
const purgeStaleReminderTasks = async ({
  opportunityId,
  leadId,
  currentStatus,
  statusEpoch,
}) => {
  const filter = {
    taskType: "reminder",
    status: "Pending",
  };

  if (opportunityId) {
    filter.opportunity = opportunityId;
    filter.$or = [
      { opportunityStatus: { $ne: currentStatus } },
      { "meta.statusSetAt": { $exists: true, $ne: statusEpoch } },
    ];
  } else if (leadId) {
    filter.lead = leadId;
    filter.$or = [
      { leadStatus: { $ne: currentStatus } },
      { "meta.statusSetAt": { $exists: true, $ne: statusEpoch } },
    ];
  } else {
    return 0;
  }

  const result = await FollowUpTask.deleteMany(filter);
  return result.deletedCount || 0;
};

/** Remove duplicate pending slot from an older sourceKey format before upsert. */
const removeConflictingReminderSlot = async ({
  opportunityId,
  leadId,
  reminderNumber,
  assigneeId,
  sourceKey,
}) => {
  const filter = {
    taskType: "reminder",
    status: "Pending",
    reminderNumber,
    assignedTo: assigneeId,
    sourceKey: { $ne: sourceKey },
  };
  if (opportunityId) filter.opportunity = opportunityId;
  else if (leadId) filter.lead = leadId;
  else return 0;

  const result = await FollowUpTask.deleteMany(filter);
  return result.deletedCount || 0;
};

const normalizeEntityType = (entityType) => {
  if (typeof entityType !== "string") return null;
  const normalized = entityType.trim().toLowerCase();
  return normalized === "lead" || normalized === "opportunity" ? normalized : null;
};

const buildEntityTypeMatch = (entityType) => {
  const type = normalizeEntityType(entityType);
  if (type === "lead") return { entityType: "lead" };
  if (type === "opportunity") {
    return {
      $or: [
        { entityType: "opportunity" },
        { entityType: { $exists: false } },
        { entityType: null },
      ],
    };
  }
  return {};
};

const withEntityTypeFilter = (base, entityType) => {
  const entityMatch = buildEntityTypeMatch(entityType);
  if (!entityMatch || Object.keys(entityMatch).length === 0) return base;
  if (entityMatch.$or) return { $and: [base, entityMatch] };
  return { ...base, ...entityMatch };
};

const upsertTask = async (payload) => {
  const existing = await FollowUpTask.findOne({ sourceKey: payload.sourceKey });
  if (existing) return { task: existing, created: false };
  const createPayload = {
    ...payload,
    originalDueAt: payload.originalDueAt || payload.dueDate,
    timingDataAvailable: true,
  };
  const task = await FollowUpTask.create(createPayload);
  await recordTaskActivity({
    eventType: "task_created",
    taskId: task._id,
    performedBy: payload.createdBy || null,
    newValue: {
      dueDate: task.dueDate,
      status: task.status,
      assignedTo: task.assignedTo,
    },
    metadata: { sourceKey: task.sourceKey, taskType: task.taskType },
  });
  return { task, created: true };
};

const upsertReminderTask = async (payload) => {
  const existing = await FollowUpTask.findOne({ sourceKey: payload.sourceKey });
  if (existing) {
    if (existing.status === "Completed" || existing.status === "Cancelled") {
      return { task: existing, created: false, updated: false };
    }

    const prevDue = existing.dueDate ? new Date(existing.dueDate).getTime() : null;
    const nextDue = payload.dueDate ? new Date(payload.dueDate).getTime() : null;
    const dueChanged = prevDue != null && nextDue != null && prevDue !== nextDue;

    if (!existing.originalDueAt && existing.dueDate) {
      existing.originalDueAt = existing.dueDate;
    }

    existing.title = payload.title;
    existing.description = payload.description;
    if (dueChanged) {
      existing.rescheduleHistory = existing.rescheduleHistory || [];
      existing.rescheduleHistory.push({
        fromDueAt: existing.dueDate,
        toDueAt: payload.dueDate,
        at: new Date(),
        by: null,
        reason: "reminder_schedule_regenerated",
      });
      existing.rescheduledCount = (existing.rescheduledCount || 0) + 1;
      existing.status =
        existing.status === "In Progress" ? "In Progress" : "Rescheduled";
      await recordTaskActivity({
        eventType: "task_rescheduled",
        taskId: existing._id,
        previousValue: { dueDate: existing.dueDate },
        newValue: { dueDate: payload.dueDate },
        metadata: { reason: "reminder_schedule_regenerated" },
      });
    }
    existing.dueDate = payload.dueDate;
    existing.opportunityStatus = payload.opportunityStatus;
    existing.leadStatus = payload.leadStatus;
    existing.scheduleCadence = payload.scheduleCadence;
    existing.emailSubject = payload.emailSubject;
    existing.emailMessage = payload.emailMessage;
    existing.reminderNumber = payload.reminderNumber;
    existing.reminderTotal = payload.reminderTotal;
    if (payload.reminderRuleId) existing.reminderRuleId = payload.reminderRuleId;
    if (payload.emailSentAt && !existing.emailSentAt) {
      existing.emailSentAt = payload.emailSentAt;
      await recordTaskActivity({
        eventType: "reminder_sent",
        taskId: existing._id,
        newValue: { emailSentAt: payload.emailSentAt },
      });
    }
    await existing.save();
    return { task: existing, created: false, updated: true };
  }

  const createPayload = {
    ...payload,
    originalDueAt: payload.originalDueAt || payload.dueDate,
    timingDataAvailable: true,
    reminderInstanceId:
      payload.reminderInstanceId ||
      `${payload.sourceKey || ""}#${payload.reminderNumber || 1}`,
  };
  const task = await FollowUpTask.create(createPayload);
  await recordTaskActivity({
    eventType: "task_created",
    taskId: task._id,
    newValue: {
      dueDate: task.dueDate,
      status: task.status,
      assignedTo: task.assignedTo,
      reminderNumber: task.reminderNumber,
    },
    metadata: {
      sourceKey: task.sourceKey,
      scheduleCadence: task.scheduleCadence,
    },
  });
  if (task.emailSentAt) {
    await recordTaskActivity({
      eventType: "reminder_sent",
      taskId: task._id,
      newValue: { emailSentAt: task.emailSentAt },
    });
  }
  return { task, created: true, updated: false };
};

/**
 * Primary owner for reminder tasks – the employee who linked the opportunity.
 */
const resolveReminderAssignee = (opportunity) => {
  if (opportunity.whoLinkthis) {
    return opportunity.whoLinkthis._id || opportunity.whoLinkthis;
  }
  if (opportunity.property?.whoCreated) {
    return opportunity.property.whoCreated._id || opportunity.property.whoCreated;
  }
  return null;
};

const createReminderTask = async (opportunity, reminderNumber) => {
  await regenerateReminderScheduleTasks(opportunity);
  return markReminderEmailSent(opportunity, reminderNumber);
};

/**
 * Pre-create all reminder slots for the current opportunity status
 * (e.g. Planning for Site Visit → 7d, +5d, +5d with email preview on each).
 */
const regenerateReminderScheduleTasks = async (opportunityInput) => {
  let opportunity = opportunityInput;
  if (!opportunity?.client?.name || !opportunity?.property?.name) {
    opportunity = await Opportunity.findById(opportunityInput._id)
      .populate("client", "name email phone")
      .populate({ path: "property", select: "name address whoCreated" })
      .populate("whoLinkthis", "name email");
    if (!opportunity) return { created: 0, updated: 0, removed: 0, slots: 0 };
  }

  const rs = opportunity.reminderState;
  if (!rs || rs.completed) {
    const removed = await FollowUpTask.deleteMany({
      opportunity: opportunity._id,
      taskType: "reminder",
      status: "Pending",
    });
    return { created: 0, updated: 0, removed: removed.deletedCount || 0, slots: 0 };
  }

  const schedule = REMINDER_SCHEDULES[rs.status];
  if (!schedule) {
    const removed = await FollowUpTask.deleteMany({
      opportunity: opportunity._id,
      taskType: "reminder",
      status: "Pending",
    });
    return { created: 0, updated: 0, removed: removed.deletedCount || 0, slots: 0 };
  }

  const assigneeId = resolveReminderAssignee(opportunity);
  if (!assigneeId) return { created: 0, updated: 0, removed: 0, slots: 0 };

  const clientName = opportunity.client?.name || "Client";
  const propertyName = opportunity.property?.name || "Property";
  const cadence = formatScheduleCadence(schedule);
  const reminderTotal = schedule.repeating ? null : schedule.intervals.length;
  const slots = computeAllReminderDueDates(rs);
  const validNumbers = slots.map((s) => s.reminderNumber);
  const remindersSent = rs.remindersSent || 0;
  const statusEpoch = getReminderStatusEpoch(rs);

  const removedStale = await purgeStaleReminderTasks({
    opportunityId: opportunity._id,
    currentStatus: rs.status,
    statusEpoch,
  });

  const removed = await FollowUpTask.deleteMany({
    opportunity: opportunity._id,
    taskType: "reminder",
    status: "Pending",
    reminderNumber: { $nin: validNumbers },
  });

  let created = 0;
  let updated = 0;

  for (const slot of slots) {
    const content = buildReminderContent(opportunity, slot.reminderNumber);
    const emailSentAt =
      slot.reminderNumber <= remindersSent && rs.lastReminderAt
        ? new Date(rs.lastReminderAt)
        : null;

    const sourceKey = buildOpportunityReminderSourceKey(
      opportunity,
      slot.reminderNumber,
      assigneeId
    );

    await removeConflictingReminderSlot({
      opportunityId: opportunity._id,
      reminderNumber: slot.reminderNumber,
      assigneeId,
      sourceKey,
    });

    const result = await upsertReminderTask({
      entityType: "opportunity",
      title: `Follow-up: ${clientName} – ${propertyName}`,
      description: `Reminder ${slot.reminderNumber}${reminderTotal ? `/${reminderTotal}` : ""} for "${rs.status}". Schedule: ${cadence}.`,
      assignedTo: assigneeId,
      opportunity: opportunity._id,
      clientName,
      propertyName,
      opportunityStatus: rs.status,
      taskType: "reminder",
      dueDate: slot.dueDate,
      status: "Pending",
      sourceKey,
      reminderNumber: slot.reminderNumber,
      reminderTotal,
      scheduleCadence: cadence,
      emailSubject: content.subject,
      emailMessage: content.inAppMessage,
      emailSentAt,
      meta: {
        reminderNumber: slot.reminderNumber,
        status: rs.status,
        statusSetAt: statusEpoch,
        cadence,
      },
    });

    if (result.created) created += 1;
    else if (result.updated) updated += 1;
  }

  return {
    created,
    updated,
    removed: (removed.deletedCount || 0) + removedStale,
    slots: slots.length,
  };
};

const markReminderEmailSent = async (opportunity, reminderNumber) => {
  const assigneeId = resolveReminderAssignee(opportunity);
  if (!assigneeId) return null;

  const sourceKey = buildOpportunityReminderSourceKey(
    opportunity,
    reminderNumber,
    assigneeId
  );

  let task = await FollowUpTask.findOne({ sourceKey });
  if (!task) {
    await regenerateReminderScheduleTasks(opportunity);
    task = await FollowUpTask.findOne({ sourceKey });
  }
  if (!task) return null;

  if (!task.emailSentAt) {
    task.emailSentAt = new Date();
    await task.save();
    await recordTaskActivity({
      eventType: "reminder_sent",
      taskId: task._id,
      newValue: { emailSentAt: task.emailSentAt },
      metadata: { reminderNumber, via: "markReminderEmailSent" },
    });
  }
  return task;
};

const resolveLeadAssignee = (lead) => {
  if (lead.assignedTo) {
    return lead.assignedTo._id || lead.assignedTo;
  }
  if (lead.createdBy) {
    return lead.createdBy._id || lead.createdBy;
  }
  return null;
};

const regenerateLeadReminderScheduleTasks = async (leadInput) => {
  let lead = leadInput;
  if (!lead?.name) {
    lead = await Lead.findById(leadInput._id)
      .populate("assignedTo", "name email")
      .populate("createdBy", "name email");
    if (!lead) return { created: 0, updated: 0, removed: 0, slots: 0 };
  }

  const rs = lead.reminderState;
  if (!rs || rs.completed || lead.isConverted) {
    const removed = await FollowUpTask.deleteMany({
      lead: lead._id,
      taskType: "reminder",
      status: "Pending",
    });
    return { created: 0, updated: 0, removed: removed.deletedCount || 0, slots: 0 };
  }

  const schedule = LEAD_REMINDER_SCHEDULES[rs.status];
  if (!schedule) {
    const removed = await FollowUpTask.deleteMany({
      lead: lead._id,
      taskType: "reminder",
      status: "Pending",
    });
    return { created: 0, updated: 0, removed: removed.deletedCount || 0, slots: 0 };
  }

  const assigneeId = resolveLeadAssignee(lead);
  if (!assigneeId) return { created: 0, updated: 0, removed: 0, slots: 0 };

  const leadName = lead.name || "Lead";
  const cadence = formatLeadScheduleCadence(schedule);
  const reminderTotal = schedule.repeating ? null : schedule.intervals.length;
  const slots = computeLeadReminderDueDates(rs);
  const validNumbers = slots.map((s) => s.reminderNumber);
  const remindersSent = rs.remindersSent || 0;
  const statusEpoch = getReminderStatusEpoch(rs);

  const removedStale = await purgeStaleReminderTasks({
    leadId: lead._id,
    currentStatus: rs.status,
    statusEpoch,
  });

  const removed = await FollowUpTask.deleteMany({
    lead: lead._id,
    taskType: "reminder",
    status: "Pending",
    reminderNumber: { $nin: validNumbers },
  });

  let created = 0;
  let updated = 0;

  for (const slot of slots) {
    const content = buildLeadReminderContent(lead, slot.reminderNumber);
    const emailSentAt =
      slot.reminderNumber <= remindersSent && rs.lastReminderAt
        ? new Date(rs.lastReminderAt)
        : null;

    const sourceKey = buildLeadReminderSourceKey(lead, slot.reminderNumber, assigneeId);

    await removeConflictingReminderSlot({
      leadId: lead._id,
      reminderNumber: slot.reminderNumber,
      assigneeId,
      sourceKey,
    });

    const result = await upsertReminderTask({
      entityType: "lead",
      title: `Lead follow-up: ${leadName}`,
      description: `Reminder ${slot.reminderNumber}${reminderTotal ? `/${reminderTotal}` : ""} for "${rs.status}". Schedule: ${cadence}.`,
      assignedTo: assigneeId,
      lead: lead._id,
      leadName,
      leadStatus: rs.status,
      taskType: "reminder",
      dueDate: slot.dueDate,
      status: "Pending",
      sourceKey,
      reminderNumber: slot.reminderNumber,
      reminderTotal,
      scheduleCadence: cadence,
      emailSubject: content.subject,
      emailMessage: content.inAppMessage,
      emailSentAt,
      meta: {
        reminderNumber: slot.reminderNumber,
        status: rs.status,
        statusSetAt: statusEpoch,
        cadence,
      },
    });

    if (result.created) created += 1;
    else if (result.updated) updated += 1;
  }

  return {
    created,
    updated,
    removed: (removed.deletedCount || 0) + removedStale,
    slots: slots.length,
  };
};

const markLeadReminderEmailSent = async (lead, reminderNumber) => {
  const assigneeId = resolveLeadAssignee(lead);
  if (!assigneeId) return null;

  const sourceKey = buildLeadReminderSourceKey(lead, reminderNumber, assigneeId);

  let task = await FollowUpTask.findOne({ sourceKey });
  if (!task) {
    await regenerateLeadReminderScheduleTasks(lead);
    task = await FollowUpTask.findOne({ sourceKey });
  }
  if (!task) return null;

  if (!task.emailSentAt) {
    task.emailSentAt = new Date();
    await task.save();
    await recordTaskActivity({
      eventType: "reminder_sent",
      taskId: task._id,
      newValue: { emailSentAt: task.emailSentAt },
      metadata: { reminderNumber, via: "markLeadReminderEmailSent" },
    });
  }
  return task;
};

const createScheduledTask = async ({
  opportunity,
  commentId,
  taskType,
  dueDate,
  assignedTo,
  title,
  description,
}) => {
  if (!assignedTo || !dueDate) return null;

  const clientName = opportunity.client?.name || "Client";
  const propertyName = opportunity.property?.name || "Property";

  return upsertTask({
    entityType: "opportunity",
    title:
      title ||
      `${taskType === "site_visit" ? "Site visit" : "Follow-up"}: ${clientName} – ${propertyName}`,
    description: description || "",
    assignedTo,
    opportunity: opportunity._id,
    clientName,
    propertyName,
    opportunityStatus: opportunity.status,
    taskType,
    dueDate: new Date(dueDate),
    status: "Pending",
    sourceKey: buildSourceKey([
      taskType,
      opportunity._id.toString(),
      commentId?.toString(),
      assignedTo.toString(),
    ]),
    commentId,
    meta: { commentId },
  }).then((r) => r);
};

const completeTaskBySource = async ({ opportunityId, commentId, taskType, userId }) => {
  const sourceKey = buildSourceKey([
    taskType,
    opportunityId.toString(),
    commentId?.toString(),
  ]);

  const tasks = await FollowUpTask.find({
    opportunity: opportunityId,
    commentId,
    taskType,
    status: { $in: ["Pending", "In Progress", "Rescheduled"] },
  });

  if (tasks.length === 0) return { modified: 0 };

  const now = new Date();
  for (const t of tasks) {
    const fields = computeCompletionFields(t, now);
    t.status = "Completed";
    t.completedAt = fields.completedAt;
    t.completedBy = userId || null;
    t.completionTiming = fields.completionTiming;
    t.actualDurationMs = fields.actualDurationMs;
    t.timingDataAvailable = fields.timingDataAvailable;
    if (!t.originalDueAt && t.dueDate) t.originalDueAt = t.dueDate;
    await t.save();
    await recordTaskActivity({
      eventType: "task_completed",
      taskId: t._id,
      performedBy: userId || null,
      previousValue: { status: "Pending" },
      newValue: {
        status: "Completed",
        completedAt: fields.completedAt,
        completionTiming: fields.completionTiming,
      },
      metadata: { via: "source_auto_complete", sourceKey },
    });
  }
  return { modified: tasks.length, sourceKey };
};

const completeTaskById = async (taskId, userId, { note } = {}) => {
  const task = await FollowUpTask.findById(taskId);
  if (!task) return { error: "not_found" };
  if (task.status === "Completed") return { error: "already_completed", task };
  if (task.status === "Cancelled") return { error: "cancelled", task };

  const prevStatus = task.status;
  const fields = computeCompletionFields(task, new Date());
  task.status = "Completed";
  task.completedAt = fields.completedAt;
  task.completedBy = userId;
  task.completionTiming = fields.completionTiming;
  task.actualDurationMs = fields.actualDurationMs;
  task.timingDataAvailable = fields.timingDataAvailable;
  if (note) task.completionNote = String(note).slice(0, 2000);
  if (!task.originalDueAt && task.dueDate) task.originalDueAt = task.dueDate;
  if (!task.startedAt) {
    task.startedAt = fields.completedAt;
  }
  await task.save();

  await recordTaskActivity({
    eventType: "task_completed",
    taskId: task._id,
    performedBy: userId || null,
    previousValue: { status: prevStatus },
    newValue: {
      status: "Completed",
      completedAt: fields.completedAt,
      completionTiming: fields.completionTiming,
      delayMs: fields.delayMs,
    },
  });

  return { task };
};

const startTaskById = async (taskId, userId) => {
  const task = await FollowUpTask.findById(taskId);
  if (!task) return { error: "not_found" };
  if (task.status === "Completed" || task.status === "Cancelled") {
    return { error: "terminal", task };
  }
  if (task.status === "In Progress" && task.startedAt) {
    return { task, alreadyStarted: true };
  }
  const prev = task.status;
  task.status = "In Progress";
  task.startedAt = task.startedAt || new Date();
  await task.save();
  await recordTaskActivity({
    eventType: "task_started",
    taskId: task._id,
    performedBy: userId || null,
    previousValue: { status: prev },
    newValue: { status: "In Progress", startedAt: task.startedAt },
  });
  return { task };
};

const rescheduleTaskById = async (taskId, userId, { dueDate, reason } = {}) => {
  const task = await FollowUpTask.findById(taskId);
  if (!task) return { error: "not_found" };
  if (task.status === "Completed" || task.status === "Cancelled") {
    return { error: "terminal", task };
  }
  const nextDue = dueDate ? new Date(dueDate) : null;
  if (!nextDue || Number.isNaN(nextDue.getTime())) {
    return { error: "invalid_due_date" };
  }
  if (!task.originalDueAt && task.dueDate) {
    task.originalDueAt = task.dueDate;
  }
  const fromDueAt = task.dueDate;
  task.rescheduleHistory = task.rescheduleHistory || [];
  task.rescheduleHistory.push({
    fromDueAt,
    toDueAt: nextDue,
    at: new Date(),
    by: userId || null,
    reason: reason ? String(reason).slice(0, 500) : "",
  });
  task.rescheduledCount = (task.rescheduledCount || 0) + 1;
  task.dueDate = nextDue;
  task.status = "Rescheduled";
  await task.save();
  await recordTaskActivity({
    eventType: "task_rescheduled",
    taskId: task._id,
    performedBy: userId || null,
    previousValue: { dueDate: fromDueAt, status: "Pending" },
    newValue: { dueDate: nextDue, status: "Rescheduled" },
    metadata: { reason: reason || "" },
  });
  return { task };
};

const enrichTaskRow = (task, now = new Date()) => {
  const timing = deriveTaskTiming(task, now);
  return {
    ...task,
    originalDueAt: task.originalDueAt || task.dueDate || null,
    timing,
  };
};

const getTaskById = async (taskId) => {
  const task = await FollowUpTask.findById(taskId)
    .populate("assignedTo", "name email role")
    .populate("completedBy", "name")
    .populate("createdBy", "name")
    .populate("opportunity", "createdAt status")
    .populate("lead", "createdAt status name contactNumber email")
    .lean();
  if (!task) return null;
  const activities = await listTaskActivities(taskId);
  return {
    ...enrichTaskRow(task),
    activities,
  };
};

const buildTabFilter = (tab, todayStart, todayEnd) => {
  const openStatus = { $in: ["Pending", "In Progress", "Rescheduled"] };
  if (tab === "daily") {
    return {
      status: openStatus,
      dueDate: { $gte: todayStart, $lte: todayEnd },
    };
  }
  if (tab === "overdue") {
    return {
      status: openStatus,
      dueDate: { $lt: todayStart },
    };
  }
  if (tab === "completed") {
    return { status: "Completed" };
  }
  if (tab === "upcoming") {
    return {
      status: openStatus,
      dueDate: { $gt: todayEnd },
    };
  }
  if (tab === "all") {
    return { status: openStatus };
  }
  return {};
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ALLOWED_SORT_FIELDS = {
  dueDate: "dueDate",
  clientName: "clientName",
  propertyName: "propertyName",
  leadName: "leadName",
  opportunityStatus: "opportunityStatus",
  leadStatus: "leadStatus",
  taskType: "taskType",
  completedAt: "completedAt",
  createdAt: "createdAt",
};

const buildQueryFilters = ({
  q,
  taskType,
  opportunityStatus,
  leadStatus,
  entityType,
  dueFrom,
  dueTo,
  emailSent,
}) => {
  const extra = {};
  const andClauses = [];

  if (q && String(q).trim()) {
    const rx = new RegExp(escapeRegex(String(q).trim()), "i");
    andClauses.push({
      $or: [
        { clientName: rx },
        { propertyName: rx },
        { leadName: rx },
        { title: rx },
      ],
    });
  }

  if (taskType && ["reminder", "follow_up", "site_visit"].includes(taskType)) {
    extra.taskType = taskType;
  }

  if (opportunityStatus && String(opportunityStatus).trim()) {
    extra.opportunityStatus = String(opportunityStatus).trim();
  }

  if (leadStatus && String(leadStatus).trim()) {
    extra.leadStatus = String(leadStatus).trim();
  }

  if (entityType && ["opportunity", "lead"].includes(entityType)) {
    andClauses.push(buildEntityTypeMatch(entityType));
  }

  if (dueFrom || dueTo) {
    extra.dueDate = { ...(extra.dueDate || {}) };
    if (dueFrom) extra.dueDate.$gte = new Date(dueFrom);
    if (dueTo) {
      const end = new Date(dueTo);
      end.setHours(23, 59, 59, 999);
      extra.dueDate.$lte = end;
    }
  }

  if (emailSent === "yes") extra.emailSentAt = { $ne: null };
  if (emailSent === "no") extra.emailSentAt = null;

  if (andClauses.length > 0) {
    extra.$and = andClauses;
  }

  return extra;
};

const buildSort = (tab, sortBy, sortOrder) => {
  const field = ALLOWED_SORT_FIELDS[sortBy];
  const dir = sortOrder === "desc" ? -1 : 1;

  if (field) {
    return { [field]: dir };
  }
  if (tab === "completed") return { completedAt: -1 };
  return { dueDate: 1 };
};

const getTaskFilterOptions = async (assigneeFilter) => {
  const base = assigneeFilter ? { assignedTo: assigneeFilter } : {};
  const [opportunityStatuses, leadStatuses, taskTypes] = await Promise.all([
    FollowUpTask.distinct("opportunityStatus", {
      ...base,
      entityType: { $ne: "lead" },
      opportunityStatus: { $ne: "" },
    }),
    FollowUpTask.distinct("leadStatus", {
      ...base,
      entityType: "lead",
      leadStatus: { $ne: "" },
    }),
    FollowUpTask.distinct("taskType", base),
  ]);

  return {
    opportunityStatuses: opportunityStatuses.filter(Boolean).sort(),
    leadStatuses: leadStatuses.filter(Boolean).sort(),
    taskTypes: taskTypes.filter(Boolean).sort(),
  };
};

const getTaskSummary = async (assigneeFilter, entityType) => {
  const todayStart = startOfDayIST();
  const todayEnd = endOfDayIST();
  const openStatus = { $in: ["Pending", "In Progress", "Rescheduled"] };

  const base = assigneeFilter ? { assignedTo: assigneeFilter } : {};
  Object.assign(base, buildEntityTypeMatch(entityType));

  const [daily, overdue, upcoming, completed, totalPending] = await Promise.all([
    FollowUpTask.countDocuments({
      ...base,
      status: openStatus,
      dueDate: { $gte: todayStart, $lte: todayEnd },
    }),
    FollowUpTask.countDocuments({
      ...base,
      status: openStatus,
      dueDate: { $lt: todayStart },
    }),
    FollowUpTask.countDocuments({
      ...base,
      status: openStatus,
      dueDate: { $gt: todayEnd },
    }),
    FollowUpTask.countDocuments({ ...base, status: "Completed" }),
    FollowUpTask.countDocuments({ ...base, status: openStatus }),
  ]);

  return { daily, overdue, upcoming, completed, totalPending };
};

const mergeDateRanges = (tabRange, userRange) => {
  if (!tabRange) return userRange;
  if (!userRange) return tabRange;

  const merged = {};
  const pickMax = (keys) => {
    const vals = keys.flatMap((k) => [tabRange[k], userRange[k]].filter(Boolean)).map((d) => new Date(d));
    return vals.length ? new Date(Math.max(...vals)) : null;
  };
  const pickMin = (keys) => {
    const vals = keys.flatMap((k) => [tabRange[k], userRange[k]].filter(Boolean)).map((d) => new Date(d));
    return vals.length ? new Date(Math.min(...vals)) : null;
  };

  const gte = pickMax(["$gte"]);
  const gt = pickMax(["$gt"]);
  const lte = pickMin(["$lte"]);
  const lt = pickMin(["$lt"]);

  if (gte) merged.$gte = gte;
  if (gt) merged.$gt = gt;
  if (lte) merged.$lte = lte;
  if (lt) merged.$lt = lt;

  return Object.keys(merged).length ? merged : tabRange;
};

const listTasks = async ({
  tab = "daily",
  assigneeFilter,
  page = 1,
  limit = 50,
  q,
  taskType,
  opportunityStatus,
  leadStatus,
  entityType,
  dueFrom,
  dueTo,
  emailSent,
  sortBy,
  sortOrder,
}) => {
  const todayStart = startOfDayIST();
  const todayEnd = endOfDayIST();
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const skip = (safePage - 1) * safeLimit;

  const tabFilter = buildTabFilter(tab, todayStart, todayEnd);
  const queryFilter = buildQueryFilters({
    q,
    taskType,
    opportunityStatus,
    leadStatus,
    entityType,
    dueFrom,
    dueTo,
    emailSent,
  });
  const { dueDate: userDueDate, ...restQuery } = queryFilter;
  const dueDate = mergeDateRanges(tabFilter.dueDate, userDueDate);

  const filter = {
    ...tabFilter,
    ...restQuery,
    ...(dueDate ? { dueDate } : {}),
    ...(assigneeFilter ? { assignedTo: assigneeFilter } : {}),
  };

  const sort = buildSort(tab, sortBy, sortOrder);

  const [data, total] = await Promise.all([
    FollowUpTask.find(filter)
      .populate("assignedTo", "name email role")
      .populate("completedBy", "name")
      .populate("opportunity", "createdAt status")
      .populate("lead", "createdAt status name contactNumber email")
      .sort(sort)
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    FollowUpTask.countDocuments(filter),
  ]);

  const now = new Date();
  return {
    data: data.map((row) => enrichTaskRow(row, now)),
    page: safePage,
    limit: safeLimit,
    total,
    totalPages: Math.max(Math.ceil(total / safeLimit), 1),
    sortBy: sortBy || (tab === "completed" ? "completedAt" : "dueDate"),
    sortOrder: sortOrder || (tab === "completed" || sortBy === "completedAt" ? "desc" : "asc"),
  };
};

const getEmployeeReports = async ({
  from,
  to,
  employeeId,
  entityType,
  taskType,
  priority,
}) => {
  const todayStart = startOfDayIST();
  const now = new Date();
  const normalizedEntityType = normalizeEntityType(entityType);

  const openStatusFilter = { $in: ["Pending", "In Progress", "Rescheduled"] };

  const buildBase = (empId, extra = {}) =>
    withEntityTypeFilter(
      {
        assignedTo: empId,
        ...(taskType && ["reminder", "follow_up", "site_visit"].includes(taskType)
          ? { taskType }
          : {}),
        ...(priority && ["Low", "Medium", "High", "Hot"].includes(priority)
          ? { priority }
          : {}),
        ...extra,
      },
      normalizedEntityType
    );

  const periodCompletedFilter = (empId) => {
    const query = buildBase(empId, { status: "Completed" });
    if (from || to) {
      query.completedAt = {};
      if (from) query.completedAt.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        query.completedAt.$lte = end;
      }
    }
    return query;
  };

  /** Tasks that were due in the period (for completion/overdue rates). */
  const periodDueFilter = (empId) => {
    const query = buildBase(empId);
    if (from || to) {
      query.dueDate = {};
      if (from) query.dueDate.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        query.dueDate.$lte = end;
      }
    }
    return query;
  };

  const employees = employeeId
    ? await User.find({ _id: employeeId, status: "Active" }).select("name email role").lean()
    : await User.find({
        role: {
          $in: [
            "Lead-Employee",
            "BO-Client",
            "BO-Lead",
            "FE-Property",
            "Product-Manager",
            "Manager",
          ],
        },
        status: "Active",
      })
        .select("name email role")
        .lean();

  const reports = [];

  for (const emp of employees) {
    const pendingBase = buildBase(emp._id, { status: openStatusFilter });

    const [
      daily,
      overdue,
      completedDocs,
      totalPending,
      dueInPeriod,
      pendingTasks,
    ] = await Promise.all([
      FollowUpTask.countDocuments(
        buildBase(emp._id, {
          status: openStatusFilter,
          dueDate: { $gte: todayStart, $lte: endOfDayIST() },
        })
      ),
      FollowUpTask.countDocuments(
        buildBase(emp._id, {
          status: openStatusFilter,
          dueDate: { $lt: todayStart },
        })
      ),
      FollowUpTask.find(periodCompletedFilter(emp._id))
        .select(
          "completedAt dueDate originalDueAt completionTiming actualDurationMs startedAt timingDataAvailable rescheduledCount taskType priority"
        )
        .lean(),
      FollowUpTask.countDocuments(pendingBase),
      FollowUpTask.countDocuments(periodDueFilter(emp._id)),
      FollowUpTask.find(pendingBase)
        .sort({ dueDate: 1 })
        .limit(20)
        .select(
          "title clientName propertyName leadName opportunityStatus leadStatus entityType taskType dueDate originalDueAt status"
        )
        .lean(),
    ]);

    let completedOnTime = 0;
    let completedLate = 0;
    let completedUnknown = 0;
    let delaySumMs = 0;
    let delayCount = 0;
    let durationSumMs = 0;
    let durationCount = 0;
    let rescheduleSum = 0;
    const byTaskTypeMap = {};
    const trendMap = {};

    for (const doc of completedDocs) {
      rescheduleSum += doc.rescheduledCount || 0;
      const timing = deriveTaskTiming(doc, now);
      if (timing.completionTiming === "on_time") completedOnTime += 1;
      else if (timing.completionTiming === "late") {
        completedLate += 1;
        if (timing.delayMs != null && timing.delayMs > 0) {
          delaySumMs += timing.delayMs;
          delayCount += 1;
        }
      } else completedUnknown += 1;

      if (doc.actualDurationMs != null && doc.actualDurationMs >= 0) {
        durationSumMs += doc.actualDurationMs;
        durationCount += 1;
      } else if (doc.startedAt && doc.completedAt) {
        const ms = new Date(doc.completedAt) - new Date(doc.startedAt);
        if (ms >= 0) {
          durationSumMs += ms;
          durationCount += 1;
        }
      }

      const tt = doc.taskType || "unknown";
      if (!byTaskTypeMap[tt]) {
        byTaskTypeMap[tt] = { taskType: tt, completed: 0, onTime: 0, late: 0, unknown: 0 };
      }
      byTaskTypeMap[tt].completed += 1;
      if (timing.completionTiming === "on_time") byTaskTypeMap[tt].onTime += 1;
      else if (timing.completionTiming === "late") byTaskTypeMap[tt].late += 1;
      else byTaskTypeMap[tt].unknown += 1;

      if (doc.completedAt) {
        const d = new Date(doc.completedAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        if (!trendMap[key]) {
          trendMap[key] = { date: key, completed: 0, onTime: 0, late: 0 };
        }
        trendMap[key].completed += 1;
        if (timing.completionTiming === "on_time") trendMap[key].onTime += 1;
        else if (timing.completionTiming === "late") trendMap[key].late += 1;
      }
    }

    const byTaskType = Object.values(byTaskTypeMap).map((row) => ({
      ...row,
      onTimeRate:
        row.onTime + row.late > 0
          ? Math.round((row.onTime / (row.onTime + row.late)) * 1000) / 10
          : null,
    }));
    const completionTrend = Object.values(trendMap).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    const completedInPeriod = completedDocs.length;
    const totalAssigned = Math.max(dueInPeriod, completedInPeriod + totalPending);
    const completionRate =
      dueInPeriod > 0
        ? Math.round((completedInPeriod / dueInPeriod) * 1000) / 10
        : completedInPeriod + totalPending > 0
          ? Math.round((completedInPeriod / (completedInPeriod + totalPending)) * 1000) / 10
          : null;

    const timedCompleted = completedOnTime + completedLate;
    const onTimeRate =
      timedCompleted > 0
        ? Math.round((completedOnTime / timedCompleted) * 1000) / 10
        : null;
    const lateRate =
      timedCompleted > 0
        ? Math.round((completedLate / timedCompleted) * 1000) / 10
        : null;
    const overdueRate =
      dueInPeriod > 0
        ? Math.round((overdue / dueInPeriod) * 1000) / 10
        : totalAssigned > 0
          ? Math.round((overdue / totalAssigned) * 1000) / 10
          : null;

    reports.push({
      employee: emp,
      daily,
      overdue,
      completed: completedInPeriod,
      completedOnTime,
      completedLate,
      completedUnknown,
      pending: totalPending,
      overdueBacklog: overdue,
      totalAssigned,
      tasksDueInPeriod: dueInPeriod,
      completionRate,
      onTimeRate,
      lateRate,
      overdueRate,
      averageDelayDays:
        delayCount > 0
          ? formatDelayDays(delaySumMs / delayCount)
          : null,
      averageDelayLabel:
        delayCount > 0 ? formatDurationMs(delaySumMs / delayCount) : null,
      averageCompletionMs:
        durationCount > 0 ? Math.round(durationSumMs / durationCount) : null,
      averageCompletionLabel:
        durationCount > 0
          ? formatDurationMs(durationSumMs / durationCount)
          : null,
      averageReschedules:
        completedInPeriod > 0
          ? Math.round((rescheduleSum / completedInPeriod) * 10) / 10
          : 0,
      historicalTimingIncomplete: completedUnknown > 0,
      byTaskType,
      completionTrend,
      pendingTasks: pendingTasks.map((p) => enrichTaskRow(p, now)),
    });
  }

  reports.sort(
    (a, b) =>
      (b.onTimeRate ?? -1) - (a.onTimeRate ?? -1) ||
      (b.overdue || 0) - (a.overdue || 0) ||
      (b.pending || 0) - (a.pending || 0)
  );
  return reports;
};

const createReminderTaskFromState = async (opportunity) => {
  return regenerateReminderScheduleTasks(opportunity);
};

/**
 * Backfill tasks from:
 *   1. Full reminder schedule per opportunity reminderState
 *   2. Pending follow-up / site-visit dates on opportunity comments
 */
const syncFromOpportunities = async () => {
  const opportunities = await Opportunity.find({ isVisibility: true })
    .populate("client", "name")
    .populate({ path: "property", select: "name whoCreated" })
    .populate("whoLinkthis", "name email")
    .lean();

  let created = 0;
  let updated = 0;
  let fromReminders = 0;
  let fromComments = 0;

  for (const opp of opportunities) {
    const assignee =
      opp.whoLinkthis ||
      opp.property?.whoCreated ||
      null;

    const reminderResult = await regenerateReminderScheduleTasks(opp);
    created += reminderResult.created || 0;
    updated += reminderResult.updated || 0;
    if ((reminderResult.created || 0) + (reminderResult.updated || 0) > 0) {
      fromReminders += 1;
    }

    if (!assignee) continue;

    for (const comment of opp.commentsSection || []) {
      if (comment.followup?.date && comment.followup.isDone !== true) {
        const { created: wasCreated } = await createScheduledTask({
          opportunity: opp,
          commentId: comment._id,
          taskType: "follow_up",
          dueDate: comment.followup.date,
          assignedTo: comment.whoCommented || assignee,
        });
        if (wasCreated) {
          created += 1;
          fromComments += 1;
        }
      }
      if (comment.sitevisit?.date && comment.sitevisit.isDone !== true) {
        const { created: wasCreated } = await createScheduledTask({
          opportunity: opp,
          commentId: comment._id,
          taskType: "site_visit",
          dueDate: comment.sitevisit.date,
          assignedTo: comment.whoCommented || assignee,
        });
        if (wasCreated) {
          created += 1;
          fromComments += 1;
        }
      }
    }
  }

  return {
    created,
    updated,
    fromReminders,
    fromComments,
    scanned: opportunities.length,
  };
};

const syncFromLeads = async () => {
  const leads = await Lead.find({ isConverted: { $ne: true } })
    .populate("assignedTo", "name email")
    .populate("createdBy", "name email")
    .lean();

  let created = 0;
  let updated = 0;
  let fromReminders = 0;

  for (const lead of leads) {
    if (!lead.reminderState?.status) continue;
    const reminderResult = await regenerateLeadReminderScheduleTasks(lead);
    created += reminderResult.created || 0;
    updated += reminderResult.updated || 0;
    if ((reminderResult.created || 0) + (reminderResult.updated || 0) > 0) {
      fromReminders += 1;
    }
  }

  return {
    created,
    updated,
    fromReminders,
    scanned: leads.length,
  };
};

const syncAll = async () => {
  const [opportunities, leads] = await Promise.all([
    syncFromOpportunities(),
    syncFromLeads(),
  ]);
  return {
    opportunities,
    leads,
    created: (opportunities.created || 0) + (leads.created || 0),
    updated: (opportunities.updated || 0) + (leads.updated || 0),
  };
};

module.exports = {
  startOfDayIST,
  endOfDayIST,
  createReminderTask,
  regenerateReminderScheduleTasks,
  regenerateLeadReminderScheduleTasks,
  markReminderEmailSent,
  markLeadReminderEmailSent,
  createScheduledTask,
  completeTaskBySource,
  completeTaskById,
  startTaskById,
  rescheduleTaskById,
  getTaskById,
  enrichTaskRow,
  getTaskSummary,
  listTasks,
  getTaskFilterOptions,
  getEmployeeReports,
  syncFromOpportunities,
  syncFromLeads,
  syncAll,
};
