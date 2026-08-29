const AgentAction = require("../models/AgentAction");

async function createAction(data) {
  return AgentAction.create(data);
}

async function listPending({ limit = 50 } = {}) {
  return AgentAction.find({ status: "pending_approval" })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

async function getById(id) {
  return AgentAction.findById(id);
}

async function hasPendingSendEmail(entityType, entityId) {
  return hasPendingIntent(entityType, entityId, "send_email");
}

async function hasPendingIntent(entityType, entityId, intent) {
  const existing = await AgentAction.findOne({
    entityType,
    entityId,
    intent,
    status: "pending_approval",
  }).lean();
  return Boolean(existing);
}

async function approve(id, userId) {
  const action = await AgentAction.findById(id);
  if (!action) return { error: "not_found" };
  if (action.status !== "pending_approval") {
    return { error: "invalid_status", action };
  }
  action.status = "approved";
  action.approvedBy = userId;
  await action.save();
  return { action };
}

async function reject(id, userId, reason = "") {
  const action = await AgentAction.findById(id);
  if (!action) return { error: "not_found" };
  if (action.status !== "pending_approval") {
    return { error: "invalid_status", action };
  }
  action.status = "rejected";
  action.rejectedBy = userId;
  action.rejectionReason = reason || "Rejected by reviewer";
  await action.save();
  return { action };
}

async function markExecuted(id, result) {
  return AgentAction.findByIdAndUpdate(
    id,
    {
      status: "executed",
      executedAt: new Date(),
      executionResult: result,
    },
    { new: true }
  );
}

async function markFailed(id, errorMessage) {
  return AgentAction.findByIdAndUpdate(
    id,
    {
      status: "failed",
      executedAt: new Date(),
      executionResult: { error: errorMessage },
    },
    { new: true }
  );
}

module.exports = {
  createAction,
  listPending,
  getById,
  hasPendingSendEmail,
  hasPendingIntent,
  approve,
  reject,
  markExecuted,
  markFailed,
};
