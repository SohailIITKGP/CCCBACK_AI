const mongoose = require("mongoose");
const Session = require("../models/Session");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const {
  ALLOWED_RESOURCES,
  buildRecordHistoryQuery,
  applyRoleScope,
} = require("../services/auditRecordHistoryService");

// Helper function to get client IP
const getClientIP = (req) => {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.headers["x-real-ip"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    "unknown"
  );
};

const requireSuperAdmin = (req, res) => {
  if (req.user.role !== "Super Admin") {
    res.status(403).json({ success: false, message: "Access denied" });
    return false;
  }
  return true;
};

const requireRecordHistoryAccess = (req, res) => {
  const allowed = ["Super Admin", "Manager", "Employee"];
  if (!allowed.includes(req.user.role)) {
    res.status(403).json({ success: false, message: "Access denied" });
    return false;
  }
  return true;
};

const buildAuditQuery = (queryParams) => {
  const { userId, action, userRole, startDate, endDate, q, resource, hideNoise, tab } =
    queryParams;
  const query = {};

  if (userId && mongoose.isValidObjectId(userId)) {
    query.userId = userId;
  }

  if (tab === "security") {
    query.action = {
      $in: [
        "login_failed",
        "login_blocked",
        "access_denied",
        "password_change",
        "data_delete",
        "admin_action",
      ],
    };
  } else if (tab === "creates") {
    query.action = "data_create";
  } else if (tab === "updates") {
    query.action = "data_update";
  } else if (tab === "deletes") {
    query.action = "data_delete";
  } else if (action) {
    query.action = action;
  }

  if (userRole) {
    query.userRole = userRole;
  }

  if (resource) {
    query.resource = resource;
  }

  if (hideNoise === "true" || hideNoise === true) {
    query["details.source"] = { $ne: "api_middleware" };
  }

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) {
      query.createdAt.$gte = new Date(startDate);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query.createdAt.$lte = end;
    }
  }

  if (q && typeof q === "string" && q.trim()) {
    const term = q.trim();
    query.$or = [
      { userEmail: { $regex: term, $options: "i" } },
      { resource: { $regex: term, $options: "i" } },
      { ipAddress: { $regex: term, $options: "i" } },
      { "details.entityName": { $regex: term, $options: "i" } },
      { "details.field": { $regex: term, $options: "i" } },
      { "details.clientName": { $regex: term, $options: "i" } },
      { "details.propertyName": { $regex: term, $options: "i" } },
    ];
  }

  return query;
};

const formatLogDetails = (log) => {
  const d = log.details || {};
  if (d.changeType === "field_change" && d.field) {
    return `${d.field}: "${d.from ?? "—"}" → "${d.to ?? "—"}"${d.entityName ? ` (${d.entityName})` : ""}`;
  }
  if (d.entityName && d.path) {
    return `${d.entityName} — ${d.method} ${d.path}`;
  }
  if (d.path) {
    return `${d.method || ""} ${d.path}`.trim();
  }
  if (d.message) return d.message;
  if (d.action) return d.action;
  return "";
};

const csvEscape = (value) => {
  const str = value == null ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

// Get all active sessions (Admin only)
exports.getAllActiveSessions = async (req, res) => {
  try {
    // Only Super Admin and Manager can view all sessions
    if (req.user.role !== "Super Admin" && req.user.role !== "Manager") {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const sessions = await Session.find({ isActive: true })
      .populate("userId", "name email role")
      .sort({ lastActivity: -1 })
      .lean();

    // Calculate session duration
    const sessionsWithDuration = sessions.map((session) => {
      const duration = new Date() - new Date(session.loginTime);
      const hours = Math.floor(duration / (1000 * 60 * 60));
      const minutes = Math.floor((duration % (1000 * 60 * 60)) / (1000 * 60));

      return {
        ...session,
        duration: `${hours}h ${minutes}m`,
        isExpired: session.lastActivity
          ? new Date() - new Date(session.lastActivity) > 24 * 60 * 60 * 1000
          : false,
      };
    });

    res.status(200).json({ success: true, data: sessionsWithDuration });
  } catch (error) {
    console.error("Error fetching active sessions:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get sessions for a specific user
exports.getUserSessions = async (req, res) => {
  try {
    const { userId } = req.params;
    const requestingUserId = req.user._id.toString();

    // Users can only see their own sessions, unless they're admin
    if (
      userId !== requestingUserId &&
      req.user.role !== "Super Admin" &&
      req.user.role !== "Manager"
    ) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const sessions = await Session.find({ userId })
      .populate("userId", "name email role")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.status(200).json({ success: true, data: sessions });
  } catch (error) {
    console.error("Error fetching user sessions:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Terminate a specific session (Admin only)
exports.terminateSession = async (req, res) => {
  try {
    // Only Super Admin and Manager can terminate sessions
    if (req.user.role !== "Super Admin" && req.user.role !== "Manager") {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const { sessionId } = req.params;
    const ipAddress = getClientIP(req);

    const session = await Session.findById(sessionId).populate("userId", "name email role");

    if (!session) {
      return res.status(404).json({ success: false, message: "Session not found" });
    }

    if (!session.isActive) {
      return res.status(400).json({ success: false, message: "Session is already inactive" });
    }

    // Terminate session
    session.isActive = false;
    session.logoutTime = new Date();
    session.logoutReason = "admin_logout";
    await session.save();

    // Log admin action
    await AuditLog.log({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: "admin_action",
      resource: "Session",
      resourceId: sessionId,
      details: {
        action: "terminate_session",
        targetUser: session.userId.email,
        targetUserId: session.userId._id,
      },
      ipAddress,
      userAgent: req.headers["user-agent"] || "",
      status: "success",
    });

    // Also log the terminated user's logout
    await AuditLog.log({
      userId: session.userId._id,
      userEmail: session.userId.email,
      userRole: session.userId.role,
      action: "logout",
      details: { sessionId: session._id, reason: "admin_logout" },
      ipAddress,
      userAgent: req.headers["user-agent"] || "",
      sessionId: session._id,
      status: "success",
    });

    res.status(200).json({
      success: true,
      message: `Session terminated for ${session.userId.email}`,
    });
  } catch (error) {
    console.error("Error terminating session:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Terminate all sessions for a user (Admin only)
exports.terminateAllUserSessions = async (req, res) => {
  try {
    // Only Super Admin and Manager can terminate sessions
    if (req.user.role !== "Super Admin" && req.user.role !== "Manager") {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const { userId } = req.params;
    const ipAddress = getClientIP(req);

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Terminate all active sessions
    const result = await Session.updateMany(
      { userId, isActive: true },
      {
        isActive: false,
        logoutTime: new Date(),
        logoutReason: "admin_logout",
      }
    );

    // Log admin action
    await AuditLog.log({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: "admin_action",
      resource: "User",
      resourceId: userId,
      details: {
        action: "terminate_all_sessions",
        targetUser: user.email,
        sessionsTerminated: result.modifiedCount,
      },
      ipAddress,
      userAgent: req.headers["user-agent"] || "",
      status: "success",
    });

    res.status(200).json({
      success: true,
      message: `All sessions terminated for ${user.email}`,
      sessionsTerminated: result.modifiedCount,
    });
  } catch (error) {
    console.error("Error terminating user sessions:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Record-level audit history (Super Admin + Manager)
exports.getRecordAuditHistory = async (req, res) => {
  try {
    if (!requireRecordHistoryAccess(req, res)) return;

    const { resource, resourceId, page = 1, limit = 30 } = req.query;

    if (!resource || !ALLOWED_RESOURCES.has(resource)) {
      return res.status(400).json({
        success: false,
        message: "Valid resource is required (Lead, Client, Property, Opportunity)",
      });
    }

    if (!resourceId || !mongoose.isValidObjectId(resourceId)) {
      return res.status(400).json({
        success: false,
        message: "Valid resourceId is required",
      });
    }

    const safeLimit = Math.min(parseInt(limit, 10) || 30, 100);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * safeLimit;

    const baseQuery = await buildRecordHistoryQuery(resource, resourceId);
    if (!baseQuery) {
      return res.status(400).json({ success: false, message: "Invalid record query" });
    }

    const query = applyRoleScope(baseQuery, req.user.role);

    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .populate("userId", "name email role")
        .sort({ createdAt: -1 })
        .limit(safeLimit)
        .skip(skip)
        .lean(),
      AuditLog.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: logs,
      pagination: {
        page: parseInt(page, 10) || 1,
        limit: safeLimit,
        total,
        pages: Math.ceil(total / safeLimit) || 1,
      },
    });
  } catch (error) {
    console.error("Error fetching record audit history:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get audit logs (Super Admin only)
exports.getAuditLogs = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { page = 1, limit = 50 } = req.query;
    const safeLimit = Math.min(parseInt(limit, 10) || 50, 200);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * safeLimit;
    const query = buildAuditQuery(req.query);

    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .populate("userId", "name email role")
        .populate("sessionId", "ipAddress userAgent deviceInfo")
        .sort({ createdAt: -1 })
        .limit(safeLimit)
        .skip(skip)
        .lean(),
      AuditLog.countDocuments(query),
    ]);

    res.status(200).json({
      success: true,
      data: logs,
      pagination: {
        page: parseInt(page, 10) || 1,
        limit: safeLimit,
        total,
        pages: Math.ceil(total / safeLimit) || 1,
      },
    });
  } catch (error) {
    console.error("Error fetching audit logs:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Export audit logs as CSV (Super Admin only)
exports.exportAuditLogs = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const query = buildAuditQuery(req.query);
    const maxRows = 10000;

    const logs = await AuditLog.find(query)
      .populate("userId", "name email role")
      .sort({ createdAt: -1 })
      .limit(maxRows)
      .lean();

    const header = [
      "Time",
      "User",
      "Email",
      "Role",
      "Action",
      "Resource",
      "Entity",
      "Details",
      "IP",
      "Status",
    ];

    const rows = logs.map((log) => [
      log.createdAt ? new Date(log.createdAt).toISOString() : "",
      log.userId?.name || "",
      log.userEmail || "",
      log.userRole || "",
      log.action || "",
      log.resource || "",
      log.details?.entityName || "",
      formatLogDetails(log),
      log.ipAddress || "",
      log.status || "",
    ]);

    const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-logs-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    res.status(200).send(csv);
  } catch (error) {
    console.error("Error exporting audit logs:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Security summary for audit dashboard (Super Admin only)
exports.getAuditSummary = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const since = new Date();
    since.setDate(since.getDate() - 1);

    const [
      failedLogins24h,
      accessDenied24h,
      dataDeletes24h,
      fieldChanges24h,
      activeSessions,
    ] = await Promise.all([
      AuditLog.countDocuments({ action: "login_failed", createdAt: { $gte: since } }),
      AuditLog.countDocuments({ action: "access_denied", createdAt: { $gte: since } }),
      AuditLog.countDocuments({ action: "data_delete", createdAt: { $gte: since } }),
      AuditLog.countDocuments({
        "details.changeType": "field_change",
        createdAt: { $gte: since },
      }),
      Session.countDocuments({ isActive: true }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        failedLogins24h,
        accessDenied24h,
        dataDeletes24h,
        fieldChanges24h,
        activeSessions,
      },
    });
  } catch (error) {
    console.error("Error fetching audit summary:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

const parseDays = (value, fallback = 7) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 90) : fallback;
};

// Per-employee activity summary (Super Admin only)
exports.getAuditEmployeeSummary = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { userId } = req.query;
    const days = parseDays(req.query.days, 7);

    if (!userId || !mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: "Valid userId is required" });
    }

    const user = await User.findById(userId).select("name email role").lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const since = new Date();
    since.setDate(since.getDate() - days);

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const baseMatch = { userId: new mongoose.Types.ObjectId(userId), createdAt: { $gte: since } };

    const [
      totalEvents,
      creates,
      updates,
      deletes,
      lastLogin,
      topResourceAgg,
      eventsToday,
      activeSessions,
      lastActivity,
    ] = await Promise.all([
      AuditLog.countDocuments(baseMatch),
      AuditLog.countDocuments({ ...baseMatch, action: "data_create" }),
      AuditLog.countDocuments({ ...baseMatch, action: "data_update" }),
      AuditLog.countDocuments({ ...baseMatch, action: "data_delete" }),
      AuditLog.findOne({ userId, action: "login", status: "success" })
        .sort({ createdAt: -1 })
        .select("createdAt ipAddress")
        .lean(),
      AuditLog.aggregate([
        { $match: { ...baseMatch, resource: { $nin: [null, ""] } } },
        { $group: { _id: "$resource", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 1 },
      ]),
      AuditLog.countDocuments({
        userId,
        createdAt: { $gte: startOfToday },
      }),
      Session.countDocuments({ userId, isActive: true }),
      AuditLog.findOne({ userId })
        .sort({ createdAt: -1 })
        .select("createdAt action resource")
        .lean(),
    ]);

    res.status(200).json({
      success: true,
      data: {
        user,
        days,
        totalEvents,
        creates,
        updates,
        deletes,
        eventsToday,
        activeSessions,
        lastLoginAt: lastLogin?.createdAt || null,
        lastLoginIp: lastLogin?.ipAddress || null,
        lastActivityAt: lastActivity?.createdAt || null,
        lastActivityAction: lastActivity?.action || null,
        topResource: topResourceAgg[0]?._id || null,
        topResourceCount: topResourceAgg[0]?.count || 0,
      },
    });
  } catch (error) {
    console.error("Error fetching employee audit summary:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Activity leaderboard + chart (Super Admin only)
exports.getAuditLeaderboard = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const days = parseDays(req.query.days, 7);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [mostActive, topDeletes, dailyActivity, employees, recentLogins] = await Promise.all([
      AuditLog.aggregate([
        {
          $match: {
            createdAt: { $gte: since },
            userId: { $ne: null },
            "details.source": { $ne: "api_middleware" },
          },
        },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: "$user" },
        {
          $project: {
            userId: "$_id",
            name: "$user.name",
            role: "$user.role",
            count: 1,
          },
        },
      ]),
      AuditLog.aggregate([
        {
          $match: {
            createdAt: { $gte: since },
            action: "data_delete",
            userId: { $ne: null },
          },
        },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: "users",
            localField: "_id",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: "$user" },
        {
          $project: {
            userId: "$_id",
            name: "$user.name",
            role: "$user.role",
            count: 1,
          },
        },
      ]),
      AuditLog.aggregate([
        {
          $match: {
            createdAt: { $gte: since },
            "details.source": { $ne: "api_middleware" },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      User.find({ role: { $ne: "Super Admin" } }).select("name email role").lean(),
      AuditLog.aggregate([
        {
          $match: {
            action: "login",
            status: "success",
            createdAt: { $gte: since },
            userId: { $ne: null },
          },
        },
        { $group: { _id: "$userId", lastLogin: { $max: "$createdAt" } } },
      ]),
    ]);

    const loginMap = new Map(recentLogins.map((row) => [String(row._id), row.lastLogin]));

    const inactive = employees
      .filter((emp) => !loginMap.has(String(emp._id)))
      .slice(0, 8)
      .map((emp) => ({
        userId: emp._id,
        name: emp.name,
        role: emp.role,
        email: emp.email,
      }));

    res.status(200).json({
      success: true,
      data: {
        days,
        mostActive,
        inactive,
        topDeletes,
        dailyActivity: dailyActivity.map((row) => ({
          date: row._id,
          count: row.count,
        })),
      },
    });
  } catch (error) {
    console.error("Error fetching audit leaderboard:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get login statistics
exports.getLoginStatistics = async (req, res) => {
  try {
    // Only Super Admin and Manager can view statistics
    if (req.user.role !== "Super Admin" && req.user.role !== "Manager") {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const { days = 7 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    // Get login statistics
    const loginStats = await AuditLog.aggregate([
      {
        $match: {
          action: "login",
          status: "success",
          createdAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            role: "$userRole",
          },
          count: { $sum: 1 },
        },
      },
      {
        $sort: { "_id.date": -1 },
      },
    ]);

    // Get active sessions count
    const activeSessionsCount = await Session.countDocuments({ isActive: true });

    // Get failed login attempts
    const failedLogins = await AuditLog.countDocuments({
      action: "login_failed",
      createdAt: { $gte: startDate },
    });

    res.status(200).json({
      success: true,
      data: {
        loginStats,
        activeSessionsCount,
        failedLogins,
      },
    });
  } catch (error) {
    console.error("Error fetching login statistics:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

