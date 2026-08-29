/**
 * Pure timing helpers for WorkTodo.
 * Never invent timestamps — missing history stays unknown.
 */

const OPEN_STATUSES = new Set(["To Do", "In Progress"]);
const TERMINAL_STATUSES = new Set(["Completed", "Cancelled"]);

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function msBetween(later, earlier) {
  const a = toDate(later);
  const b = toDate(earlier);
  if (!a || !b) return null;
  return a.getTime() - b.getTime();
}

function formatDurationMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const abs = Math.abs(Math.round(ms));
  const sign = ms < 0 ? "-" : "";
  const days = Math.floor(abs / 86400000);
  const hours = Math.floor((abs % 86400000) / 3600000);
  const minutes = Math.floor((abs % 3600000) / 60000);
  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (!days && (minutes || !parts.length)) {
    parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  }
  return `${sign}${parts.join(" ")}`.trim();
}

function deriveTodoTiming(todo, now = new Date()) {
  const dueAt = toDate(todo.dueAt);
  const completedAt = toDate(todo.completedAt);
  const status = todo.status || "To Do";

  let completionTiming = todo.completionTiming || null;
  let isOnTime = null;
  let delayMs = null;
  let overdueMs = null;
  let isOverdue = false;
  let displayStatus = status;
  let delayLabel = null;
  let overdueLabel = null;

  if (status === "Completed") {
    if (!completedAt || !dueAt) {
      completionTiming = "unknown";
      isOnTime = null;
      displayStatus = "Completed";
    } else if (completedAt.getTime() <= dueAt.getTime()) {
      completionTiming = "on_time";
      isOnTime = true;
      delayMs = 0;
      displayStatus = "Completed On Time";
    } else {
      completionTiming = "late";
      isOnTime = false;
      delayMs = completedAt.getTime() - dueAt.getTime();
      delayLabel = formatDurationMs(delayMs);
      displayStatus = "Completed Late";
    }
  } else if (status === "Cancelled") {
    displayStatus = "Cancelled";
    isOverdue = false;
  } else if (dueAt && now.getTime() > dueAt.getTime()) {
    isOverdue = true;
    overdueMs = now.getTime() - dueAt.getTime();
    overdueLabel = formatDurationMs(overdueMs);
    displayStatus = "Overdue";
  }

  return {
    displayStatus,
    completionTiming,
    isOverdue,
    isOnTime,
    delayMs,
    overdueMs,
    delayLabel,
    overdueLabel,
    dueAt: dueAt ? dueAt.toISOString() : null,
    completedAt: completedAt ? completedAt.toISOString() : null,
    originalDueAt: toDate(todo.originalDueAt || todo.dueAt)
      ? toDate(todo.originalDueAt || todo.dueAt).toISOString()
      : null,
  };
}

function computeCompletionFields(todo, completedAt = new Date()) {
  const dueAt = toDate(todo.dueAt);
  const doneAt = toDate(completedAt) || new Date();
  if (!dueAt) {
    return { completionTiming: "unknown", completedAt: doneAt };
  }
  if (doneAt.getTime() <= dueAt.getTime()) {
    return { completionTiming: "on_time", completedAt: doneAt };
  }
  return { completionTiming: "late", completedAt: doneAt };
}

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

module.exports = {
  OPEN_STATUSES,
  TERMINAL_STATUSES,
  toDate,
  msBetween,
  formatDurationMs,
  deriveTodoTiming,
  computeCompletionFields,
  startOfDay,
  endOfDay,
};
