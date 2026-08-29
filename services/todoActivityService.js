const TodoActivity = require("../models/TodoActivity");

async function recordTodoActivity({
  eventType,
  todoId,
  performedBy = null,
  previousValue = null,
  newValue = null,
  metadata = {},
  timestamp = new Date(),
}) {
  if (!todoId || !eventType) return null;
  try {
    return await TodoActivity.create({
      eventType,
      todoId,
      performedBy,
      previousValue,
      newValue,
      metadata,
      timestamp,
    });
  } catch (err) {
    console.error("[todoActivity] failed to record", eventType, err.message);
    return null;
  }
}

async function listTodoActivities(todoId, { limit = 200 } = {}) {
  return TodoActivity.find({ todoId })
    .populate("performedBy", "name email role")
    .sort({ timestamp: 1 })
    .limit(Math.min(Number(limit) || 200, 500))
    .lean();
}

module.exports = {
  recordTodoActivity,
  listTodoActivities,
};
