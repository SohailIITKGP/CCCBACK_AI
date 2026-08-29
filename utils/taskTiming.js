/**
 * Pure helpers for FollowUpTask timing / on-time vs late classification.
 * Never invent timestamps — missing history → timingDataAvailable: false.
 */

const OPEN_STATUSES = new Set(["Pending", "In Progress", "Rescheduled"]);
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
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || !parts.length) parts.push(`${minutes}m`);
  return `${sign}${parts.join(" ")}`;
}

function formatDelayDays(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round((ms / 86400000) * 10) / 10;
}

/**
 * @returns {{
 *   displayStatus: string,
 *   completionTiming: 'on_time'|'late'|'unknown'|null,
 *   isOverdue: boolean,
 *   isOnTime: boolean|null,
 *   delayMs: number|null,
 *   overdueMs: number|null,
 *   delayLabel: string|null,
 *   overdueLabel: string|null,
 *   timingDataAvailable: boolean,
 * }}
 */
function deriveTaskTiming(task, now = new Date()) {
  const dueAt = toDate(task.dueDate || task.dueAt);
  const completedAt = toDate(task.completedAt);
  const status = task.status || "Pending";
  const timingDataAvailable =
    task.timingDataAvailable !== false &&
    (status !== "Completed" || Boolean(completedAt));

  let completionTiming = task.completionTiming || null;
  let isOnTime = null;
  let delayMs = null;
  let overdueMs = null;
  let isOverdue = false;
  let displayStatus = status;

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
      displayStatus = "Completed Late";
    }
  } else if (status === "Cancelled") {
    displayStatus = "Cancelled";
  } else if (status === "Rescheduled") {
    displayStatus = "Rescheduled";
    if (dueAt && now.getTime() > dueAt.getTime()) {
      isOverdue = true;
      overdueMs = now.getTime() - dueAt.getTime();
      displayStatus = "Overdue";
    }
  } else if (OPEN_STATUSES.has(status) || status === "In Progress") {
    if (status === "In Progress") displayStatus = "In Progress";
    else displayStatus = "Pending";
    if (dueAt && now.getTime() > dueAt.getTime()) {
      isOverdue = true;
      overdueMs = now.getTime() - dueAt.getTime();
      displayStatus = "Overdue";
    }
  }

  return {
    displayStatus,
    completionTiming,
    isOverdue,
    isOnTime,
    delayMs,
    overdueMs,
    delayLabel: delayMs != null && delayMs > 0 ? formatDurationMs(delayMs) : null,
    overdueLabel: overdueMs != null && overdueMs > 0 ? formatDurationMs(overdueMs) : null,
    timingDataAvailable,
  };
}

function computeCompletionFields(task, completedAt = new Date()) {
  const dueAt = toDate(task.dueDate);
  const startedAt = toDate(task.startedAt);
  const doneAt = toDate(completedAt) || new Date();

  let completionTiming = "unknown";
  let delayMs = null;
  if (dueAt) {
    if (doneAt.getTime() <= dueAt.getTime()) {
      completionTiming = "on_time";
      delayMs = 0;
    } else {
      completionTiming = "late";
      delayMs = doneAt.getTime() - dueAt.getTime();
    }
  }

  const actualDurationMs =
    startedAt != null ? Math.max(0, doneAt.getTime() - startedAt.getTime()) : null;

  return {
    completedAt: doneAt,
    completionTiming,
    delayMs,
    actualDurationMs,
    timingDataAvailable: Boolean(dueAt),
  };
}

module.exports = {
  OPEN_STATUSES,
  TERMINAL_STATUSES,
  toDate,
  msBetween,
  formatDurationMs,
  formatDelayDays,
  deriveTaskTiming,
  computeCompletionFields,
};
