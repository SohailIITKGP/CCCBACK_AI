const AuditLog = require("../models/AuditLog");
const {
  getClientIP,
  parseResourceIdFromPath,
  baseFromRequest,
} = require("../utils/auditLogger");

const SKIP_PREFIXES = [
  "/api/notifications",
  "/api/chat",
  "/api/sessions/audit-logs",
  "/api/sessions/audit-logs/export",
  "/api/sessions/audit-summary",
  "/api/sessions/statistics",
  "/api/sessions/active",
];

const SENSITIVE_READ_PREFIXES = [
  "/api/reports",
  "/api/track",
  "/api/data",
];

const inferResource = (url) => {
  const segment = url.replace(/^\/api\/?/, "").split("/")[0] || "";
  const map = {
    leads: "Lead",
    clients: "Client",
    properties: "Property",
    opportunities: "Opportunity",
    users: "User",
    "follow-up-tasks": "Task",
    todos: "Todo",
    teams: "Team",
    link: "Opportunity",
    proposal: "Proposal",
    settings: "Settings",
    sessions: "Session",
  };
  return map[segment] || segment || "API";
};

const inferAction = (method, url) => {
  if (method === "POST") return "data_create";
  if (method === "PUT" || method === "PATCH") return "data_update";
  if (method === "DELETE") return "data_delete";
  if (method === "GET" && SENSITIVE_READ_PREFIXES.some((p) => url.startsWith(p))) {
    return "data_export";
  }
  return null;
};

const shouldAudit = (req) => {
  const url = req.originalUrl || req.url || "";
  if (SKIP_PREFIXES.some((p) => url.startsWith(p))) return false;
  if (!req.user) return false;

  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return true;
  if (req.method === "GET" && SENSITIVE_READ_PREFIXES.some((p) => url.startsWith(p))) {
    return true;
  }
  return false;
};

const attachAuditLogger = (req, res) => {
  if (!shouldAudit(req)) return;

  const url = req.originalUrl || req.url || "";
  const action = inferAction(req.method, url);
  if (!action) return;

  const resourceId = parseResourceIdFromPath(url);
  const pathOnly = url.split("?")[0];

  res.on("finish", () => {
    if (req.skipAuditMiddleware) return;

    const statusCode = res.statusCode;
    const isFailure = statusCode >= 400;
    const logAction = isFailure && statusCode === 403 ? "access_denied" : action;
    const logStatus =
      statusCode >= 500 ? "failed" : isFailure ? "failed" : "success";

    if (isFailure && statusCode !== 403 && statusCode !== 401) {
      return;
    }

    AuditLog.log({
      ...baseFromRequest(req),
      action: logAction,
      resource: inferResource(url),
      resourceId,
      details: {
        method: req.method,
        path: pathOnly,
        statusCode,
        source: "api_middleware",
      },
      status: logStatus,
    }).catch(() => {});
  });
};

module.exports = { attachAuditLogger, shouldAudit };
