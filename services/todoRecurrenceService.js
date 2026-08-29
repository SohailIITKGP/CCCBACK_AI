const WorkTodo = require("../models/WorkTodo");
const { recordTodoActivity } = require("./todoActivityService");
const { toDate } = require("../utils/todoTiming");

const MAX_GENERATED = 8;

function cloneOccurrenceDate(base, frequency, interval, index) {
  const d = new Date(base);
  if (frequency === "daily") {
    d.setDate(d.getDate() + interval * index);
  } else if (frequency === "weekly") {
    d.setDate(d.getDate() + 7 * interval * index);
  } else if (frequency === "monthly") {
    d.setMonth(d.getMonth() + interval * index);
  } else if (frequency === "custom") {
    d.setDate(d.getDate() + interval * index);
  } else {
    return null;
  }
  return d;
}

function occurrenceKey(parentId, date) {
  return `${parentId}:${date.toISOString().slice(0, 10)}`;
}

function shiftTime(from, toDateValue) {
  if (!from || !toDateValue) return null;
  const src = new Date(from);
  const dest = new Date(toDateValue);
  dest.setHours(src.getHours(), src.getMinutes(), src.getSeconds(), 0);
  return dest;
}

/**
 * Create future occurrence documents without touching historical rows.
 */
async function generateUpcomingOccurrences(parentTodo, { lookaheadDays = 28, actorId = null } = {}) {
  const rec = parentTodo.recurrence || {};
  if (!rec.enabled || rec.frequency === "none") return { created: 0 };

  const template = parentTodo.toObject ? parentTodo.toObject() : parentTodo;
  const parentId = template.parentTodoId || template._id;
  const dueBase = toDate(template.dueAt) || toDate(template.startAt) || new Date();
  const until = toDate(rec.until);
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + lookaheadDays);

  let created = 0;
  for (let i = 1; i <= MAX_GENERATED; i += 1) {
    const nextDue = cloneOccurrenceDate(dueBase, rec.frequency, rec.interval || 1, i);
    if (!nextDue) break;
    if (until && nextDue > until) break;
    if (nextDue > horizon && i > 1) break;

    const key = occurrenceKey(parentId, nextDue);
    const exists = await WorkTodo.findOne({ occurrenceKey: key }).select("_id").lean();
    if (exists) continue;

    const nextStart = shiftTime(template.startAt, nextDue);
    const reminders = (template.reminders || []).map((r) => ({
      kind: r.kind,
      offsetMinutes: r.offsetMinutes,
      label: r.label,
      sentAt: null,
      remindAt:
        r.kind === "relative" && r.offsetMinutes != null
          ? new Date(nextDue.getTime() - Number(r.offsetMinutes) * 60 * 1000)
          : null,
    }));

    const occurrence = await WorkTodo.create({
      title: template.title,
      description: template.description,
      status: "To Do",
      priority: template.priority,
      category: template.category,
      owner: template.owner,
      createdBy: template.createdBy,
      assignedTo: template.assignedTo,
      assignedBy: template.assignedBy,
      assignedAt: new Date(),
      collaborators: template.collaborators,
      team: template.team,
      startAt: nextStart,
      dueAt: nextDue,
      originalDueAt: nextDue,
      reminders,
      recurrence: {
        enabled: false,
        frequency: "none",
        interval: 1,
        daysOfWeek: [],
        dayOfMonth: null,
        until: null,
      },
      parentTodoId: parentId,
      occurrenceDate: nextDue,
      occurrenceKey: key,
      sourceType: template.sourceType,
      sourceId: template.sourceId,
      sourceName: template.sourceName,
    });

    await recordTodoActivity({
      eventType: "task_created",
      todoId: occurrence._id,
      performedBy: actorId,
      metadata: { occurrenceOf: String(parentId), occurrenceDate: nextDue },
    });
    created += 1;
  }

  return { created };
}

module.exports = {
  generateUpcomingOccurrences,
};
