const { randomUUID } = require("crypto");
const CrmException = require("../models/CrmException");
const User = require("../models/User");
const createNotification = require("../utils/notification");
const { enqueueOutboxEvent } = require("./outboxService");
const { isOrchestrationEnabled } = require("../config/orchestration");
const { getExceptionConfig } = require("../config/exceptionTypes");

function computeSlaDueAt(slaHours) {
  const d = new Date();
  d.setHours(d.getHours() + (slaHours || 24));
  return d;
}

async function findExistingByDedupe(dedupeKey) {
  if (!dedupeKey) return null;
  return CrmException.findOne({
    dedupeKey,
    status: { $in: ["open", "assigned"] },
  }).lean();
}

/**
 * Raise an exception (idempotent when dedupeKey provided).
 */
async function raiseException({
  type,
  correlationId = null,
  entityType = null,
  entityId = null,
  title,
  description = "",
  payload = {},
  sourceEventId = null,
  sourceEventType = null,
  dedupeKey = null,
  ownerRole = null,
  severity = null,
  slaHours = null,
  notify = true,
}) {
  const config = getExceptionConfig(type);

  if (dedupeKey) {
    const existing = await findExistingByDedupe(dedupeKey);
    if (existing) {
      return { raised: false, skipped: true, reason: "duplicate", exception: existing };
    }
  }

  const exceptionId = randomUUID();
  const doc = await CrmException.create({
    exceptionId,
    type,
    severity: severity || config.severity,
    status: "open",
    ownerRole: ownerRole || config.ownerRole,
    correlationId,
    entityType,
    entityId,
    title,
    description,
    sourceEventId,
    sourceEventType,
    payload,
    slaDueAt: computeSlaDueAt(slaHours ?? config.slaHours),
    dedupeKey: dedupeKey || undefined,
  });

  if (isOrchestrationEnabled() && correlationId) {
    await enqueueOutboxEvent({
      eventType: "exception.raised",
      aggregateType: "CrmException",
      aggregateId: doc._id,
      correlationId,
      schemaVersion: 1,
      metadata: { actor: "system" },
      payload: {
        exceptionId,
        type,
        title,
        ownerRole: doc.ownerRole,
        correlationId,
        entityType,
        entityId: entityId?.toString?.() || null,
      },
    });
  }

  if (notify) {
    await notifyOwnerRole(doc);
  }

  return { raised: true, exception: doc };
}

async function notifyOwnerRole(exception) {
  const users = await User.find({
    role: exception.ownerRole,
    status: "Active",
  }).select("_id");

  const message = `[Exception] ${exception.title}${exception.description ? ` — ${exception.description.slice(0, 120)}` : ""}`;

  await Promise.allSettled(
    users.map((user) =>
      createNotification(
        "Exception",
        exception.type,
        exception._id,
        exception.title,
        user._id,
        message
      )
    )
  );

  return { notified: users.length };
}

async function listExceptions({
  status = "open",
  ownerRole = null,
  type = null,
  correlationId = null,
  limit = 50,
  skip = 0,
  userRole = null,
}) {
  const query = {};
  if (status && status !== "all") {
    query.status = Array.isArray(status) ? { $in: status } : status;
  }
  if (type) query.type = type;
  if (correlationId) query.correlationId = correlationId;
  if (ownerRole) {
    query.ownerRole = ownerRole;
  } else if (userRole && userRole !== "Super Admin") {
    query.ownerRole = userRole;
  }

  const [items, total, overdue] = await Promise.all([
    CrmException.find(query)
      .sort({ slaDueAt: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("assignedTo", "name email role")
      .populate("resolvedBy", "name")
      .lean(),
    CrmException.countDocuments(query),
    CrmException.countDocuments({
      ...query,
      status: { $in: ["open", "assigned"] },
      slaDueAt: { $lt: new Date() },
    }),
  ]);

  return { items, total, overdue, limit, skip };
}

async function getExceptionSummary(userRole = null) {
  const base = userRole && userRole !== "Super Admin" ? { ownerRole: userRole } : {};
  const [open, overdue, resolvedToday] = await Promise.all([
    CrmException.countDocuments({ ...base, status: { $in: ["open", "assigned"] } }),
    CrmException.countDocuments({
      ...base,
      status: { $in: ["open", "assigned"] },
      slaDueAt: { $lt: new Date() },
    }),
    CrmException.countDocuments({
      ...base,
      status: "resolved",
      resolvedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    }),
  ]);

  const byType = await CrmException.aggregate([
    { $match: { ...base, status: { $in: ["open", "assigned"] } } },
    { $group: { _id: "$type", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  return { open, overdue, resolvedToday, byType };
}

async function resolveException(exceptionId, userId, resolution = "") {
  const doc = await CrmException.findOneAndUpdate(
    { exceptionId, status: { $in: ["open", "assigned"] } },
    {
      status: "resolved",
      resolvedAt: new Date(),
      resolvedBy: userId,
      resolution: String(resolution || "").slice(0, 2000),
    },
    { new: true }
  );
  return doc;
}

async function dismissException(exceptionId, userId, resolution = "") {
  const doc = await CrmException.findOneAndUpdate(
    { exceptionId, status: { $in: ["open", "assigned"] } },
    {
      status: "dismissed",
      resolvedAt: new Date(),
      resolvedBy: userId,
      resolution: String(resolution || "dismissed").slice(0, 2000),
    },
    { new: true }
  );
  return doc;
}

async function assignException(exceptionId, assigneeId) {
  return CrmException.findOneAndUpdate(
    { exceptionId, status: { $in: ["open", "assigned"] } },
    { assignedTo: assigneeId, status: "assigned" },
    { new: true }
  );
}

module.exports = {
  raiseException,
  listExceptions,
  getExceptionSummary,
  resolveException,
  dismissException,
  assignException,
  notifyOwnerRole,
};
