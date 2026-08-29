const mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");

const getClientIP = (req) =>
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
  req.headers["x-real-ip"] ||
  req.connection?.remoteAddress ||
  req.socket?.remoteAddress ||
  "unknown";

const parseResourceIdFromPath = (url) => {
  if (!url) return null;
  const segments = url.split("?")[0].split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (mongoose.isValidObjectId(segments[i])) {
      return segments[i];
    }
  }
  return null;
};

const baseFromRequest = (req) => ({
  userId: req.user?._id || null,
  userEmail: req.user?.email || "system",
  userRole: req.user?.role || "unknown",
  ipAddress: getClientIP(req),
  userAgent: req.headers["user-agent"] || "",
  sessionId: req.session?._id || null,
});

/**
 * Log a structured field change (status, assignee, etc.).
 */
const logFieldChange = async (
  req,
  {
    resource,
    resourceId,
    entityName,
    field,
    from,
    to,
    action = "data_update",
    extra = {},
  }
) => {
  if (!req?.user) return null;
  req.skipAuditMiddleware = true;
  return AuditLog.log({
    ...baseFromRequest(req),
    action,
    resource,
    resourceId: resourceId || null,
    status: "success",
    details: {
      entityName: entityName || "",
      field,
      from: from ?? null,
      to: to ?? null,
      changeType: "field_change",
      ...extra,
    },
  });
};

const logDataAction = async (
  req,
  {
    action,
    resource,
    resourceId,
    entityName,
    details = {},
    status = "success",
  }
) => {
  if (!req?.user && status === "success") return null;
  req.skipAuditMiddleware = true;
  return AuditLog.log({
    ...baseFromRequest(req),
    action,
    resource,
    resourceId: resourceId || null,
    status,
    details: {
      entityName: entityName || "",
      ...details,
    },
  });
};

const logAccessDenied = async (req, { resource, message, resourceId = null }) => {
  return AuditLog.log({
    ...baseFromRequest(req),
    action: "access_denied",
    resource: resource || "API",
    resourceId,
    status: "failed",
    details: {
      message: message || "Access denied",
      path: req.originalUrl?.split("?")[0] || "",
      method: req.method,
    },
  });
};

/**
 * Log multiple scalar field changes between two object snapshots.
 */
const logTrackedFieldChanges = async (
  req,
  { resource, resourceId, entityName, previous, next, fields, extra = {} }
) => {
  if (!req?.user || !previous || !next) return;

  await Promise.all(
    fields.map(async (field) => {
      if (next[field] === undefined) return;
      const fromVal = previous[field];
      const toVal = next[field];
      const fromStr = fromVal == null || fromVal === "" ? null : String(fromVal);
      const toStr = toVal == null || toVal === "" ? null : String(toVal);
      if (fromStr === toStr) return;

      return logFieldChange(req, {
        resource,
        resourceId,
        entityName,
        field,
        from: fromStr ?? "—",
        to: toStr ?? "—",
        extra,
      });
    })
  );
};

const formatTaskEntityName = (task) => {
  if (!task) return "Task";
  if (task.entityType === "lead") {
    return task.leadName || task.title || "Lead task";
  }
  const client = task.clientName || "";
  const property = task.propertyName || "";
  if (client && property) return `${client} – ${property}`;
  return task.title || client || property || "Task";
};

/** Log CRM automation events (email, AI) without an HTTP request context. */
const logAutomationEvent = async ({
  action = "data_update",
  resource,
  resourceId,
  entityName,
  details = {},
  status = "success",
}) => {
  if (!resourceId) return null;
  return AuditLog.log({
    userId: null,
    userEmail: "automation@crm",
    userRole: "System",
    action,
    resource,
    resourceId,
    status,
    ipAddress: "system",
    userAgent: "crm-automation",
    details: {
      entityName: entityName || "",
      source: "automation",
      ...details,
    },
  });
};

module.exports = {
  getClientIP,
  parseResourceIdFromPath,
  logFieldChange,
  logDataAction,
  logAccessDenied,
  logTrackedFieldChanges,
  formatTaskEntityName,
  baseFromRequest,
  logAutomationEvent,
};
