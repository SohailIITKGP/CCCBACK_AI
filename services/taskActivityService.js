const TaskActivity = require("../models/TaskActivity");

async function recordTaskActivity({
  eventType,
  taskId,
  performedBy = null,
  previousValue = null,
  newValue = null,
  metadata = {},
  timestamp = new Date(),
}) {
  if (!taskId || !eventType) return null;
  try {
    return await TaskActivity.create({
      eventType,
      taskId,
      performedBy,
      previousValue,
      newValue,
      metadata,
      timestamp,
    });
  } catch (err) {
    console.error("[taskActivity] failed to record", eventType, err.message);
    return null;
  }
}

async function listTaskActivities(taskId, { limit = 100 } = {}) {
  return TaskActivity.find({ taskId })
    .populate("performedBy", "name email role")
    .sort({ timestamp: 1 })
    .limit(Math.min(limit, 500))
    .lean();
}

module.exports = {
  recordTaskActivity,
  listTaskActivities,
};
