const mongoose = require("mongoose");
const {
  listTasks,
  getTaskSummary,
  getTaskFilterOptions,
  getEmployeeReports,
  completeTaskById,
  startTaskById,
  rescheduleTaskById,
  getTaskById,
  enrichTaskRow,
  syncAll,
} = require("../services/followUpTaskService");
const { getReminderSchedulesForUI } = require("../services/opportunityReminderService");
const { getLeadReminderSchedulesForUI } = require("../services/leadReminderService");
const {
  logFieldChange,
  logDataAction,
  formatTaskEntityName,
} = require("../utils/auditLogger");

const ADMIN_ROLES = ["Super Admin", "Manager"];
const TASK_ROLES = [
  "Super Admin",
  "Manager",
  "BO-Client",
  "Lead-Employee",
  "Product-Manager",
  "BO-Lead",
  "FE-Property",
];

const isAdmin = (user) => user && ADMIN_ROLES.includes(user.role);

exports.getSummary = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });

    const { entityType } = req.query;

    const assigneeFilter =
      isAdmin(req.user) && req.query.employeeId
        ? req.query.employeeId
        : isAdmin(req.user) && req.query.view === "all"
          ? null
          : req.user._id;

    const summary = await getTaskSummary(assigneeFilter, entityType);
    return res.status(200).json({ success: true, summary });
  } catch (error) {
    console.error("getSummary error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch summary" });
  }
};

exports.listTasks = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });
    if (!TASK_ROLES.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const {
      tab = "daily",
      page,
      limit,
      employeeId,
      view,
      q,
      taskType,
      opportunityStatus,
      leadStatus,
      entityType,
      dueFrom,
      dueTo,
      emailSent,
      sortBy,
      sortOrder,
    } = req.query;

    let assigneeFilter = req.user._id;
    if (isAdmin(req.user)) {
      if (employeeId && mongoose.isValidObjectId(employeeId)) {
        assigneeFilter = employeeId;
      } else if (view === "all") {
        assigneeFilter = null;
      }
    }

    const result = await listTasks({
      tab,
      assigneeFilter,
      page,
      limit,
      q,
      taskType,
      opportunityStatus,
      leadStatus,
      entityType,
      dueFrom,
      dueTo,
      emailSent,
      sortBy,
      sortOrder,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("listTasks error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch tasks" });
  }
};

exports.completeTask = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });

    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid task id" });
    }

    const FollowUpTask = require("../models/FollowUpTask");
    const existing = await FollowUpTask.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    const canComplete =
      isAdmin(req.user) ||
      existing.assignedTo.toString() === req.user._id.toString();

    if (!canComplete) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const result = await completeTaskById(id, req.user._id, {
      note: req.body?.completionNote || req.body?.note,
    });
    if (result.error === "not_found") {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    if (result.error === "already_completed") {
      return res.status(400).json({ success: false, message: "Task already completed" });
    }
    if (result.error === "cancelled") {
      return res.status(400).json({ success: false, message: "Task is cancelled" });
    }

    logFieldChange(req, {
      resource: "Task",
      resourceId: existing._id,
      entityName: formatTaskEntityName(existing),
      field: "status",
      from: existing.status,
      to: "Completed",
      extra: {
        taskType: existing.taskType,
        entityType: existing.entityType || "opportunity",
        dueDate: existing.dueDate,
        completionTiming: result.task?.completionTiming,
      },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: "Task marked as completed",
      task: enrichTaskRow(result.task.toObject ? result.task.toObject() : result.task),
    });
  } catch (error) {
    console.error("completeTask error:", error);
    return res.status(500).json({ success: false, message: "Failed to complete task" });
  }
};

exports.startTask = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid task id" });
    }

    const FollowUpTask = require("../models/FollowUpTask");
    const existing = await FollowUpTask.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    const canAct =
      isAdmin(req.user) ||
      existing.assignedTo.toString() === req.user._id.toString();
    if (!canAct) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const result = await startTaskById(id, req.user._id);
    if (result.error === "not_found") {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    if (result.error === "terminal") {
      return res.status(400).json({ success: false, message: "Task cannot be started" });
    }
    return res.status(200).json({
      success: true,
      task: enrichTaskRow(result.task.toObject ? result.task.toObject() : result.task),
    });
  } catch (error) {
    console.error("startTask error:", error);
    return res.status(500).json({ success: false, message: "Failed to start task" });
  }
};

exports.rescheduleTask = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid task id" });
    }

    const FollowUpTask = require("../models/FollowUpTask");
    const existing = await FollowUpTask.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    const canAct =
      isAdmin(req.user) ||
      existing.assignedTo.toString() === req.user._id.toString();
    if (!canAct) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const result = await rescheduleTaskById(id, req.user._id, {
      dueDate: req.body?.dueDate,
      reason: req.body?.reason,
    });
    if (result.error === "not_found") {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    if (result.error === "terminal") {
      return res.status(400).json({ success: false, message: "Task cannot be rescheduled" });
    }
    if (result.error === "invalid_due_date") {
      return res.status(400).json({ success: false, message: "Valid dueDate is required" });
    }

    logFieldChange(req, {
      resource: "Task",
      resourceId: existing._id,
      entityName: formatTaskEntityName(existing),
      field: "dueDate",
      from: existing.dueDate,
      to: result.task.dueDate,
      extra: { originalDueAt: result.task.originalDueAt },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      task: enrichTaskRow(result.task.toObject ? result.task.toObject() : result.task),
    });
  } catch (error) {
    console.error("rescheduleTask error:", error);
    return res.status(500).json({ success: false, message: "Failed to reschedule task" });
  }
};

exports.getTaskDetail = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid task id" });
    }

    const task = await getTaskById(id);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }

    const canView =
      isAdmin(req.user) ||
      String(task.assignedTo?._id || task.assignedTo) === String(req.user._id);
    if (!canView) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    return res.status(200).json({ success: true, task });
  } catch (error) {
    console.error("getTaskDetail error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch task" });
  }
};

exports.getEmployeeReports = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const { from, to, employeeId, entityType, taskType, priority } = req.query;
    const reports = await getEmployeeReports({
      from,
      to,
      employeeId,
      entityType,
      taskType,
      priority,
    });
    return res.status(200).json({ success: true, reports });
  } catch (error) {
    console.error("getEmployeeReports error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch reports" });
  }
};

exports.syncFromOpportunities = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });
    if (!isAdmin(req.user)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const result = await syncAll();

    logDataAction(req, {
      action: "admin_action",
      resource: "Task",
      details: {
        action: "sync_tasks",
        created: result.created ?? 0,
        updated: result.updated ?? 0,
        opportunities: result.opportunities?.scanned,
        leads: result.leads?.scanned,
      },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: "Sync completed",
      ...result,
    });
  } catch (error) {
    console.error("syncFromOpportunities error:", error);
    return res.status(500).json({ success: false, message: "Sync failed" });
  }
};

exports.getReminderSchedules = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });
    if (!TASK_ROLES.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    return res.status(200).json({
      success: true,
      schedules: getReminderSchedulesForUI(),
      leadSchedules: getLeadReminderSchedulesForUI(),
    });
  } catch (error) {
    console.error("getReminderSchedules error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch schedules" });
  }
};

exports.getFilterOptions = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ success: false, message: "Unauthorized" });
    if (!TASK_ROLES.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const { employeeId, view } = req.query;
    let assigneeFilter = req.user._id;
    if (isAdmin(req.user)) {
      if (employeeId && mongoose.isValidObjectId(employeeId)) {
        assigneeFilter = employeeId;
      } else if (view === "all") {
        assigneeFilter = null;
      }
    }

    const options = await getTaskFilterOptions(assigneeFilter);
    return res.status(200).json({ success: true, ...options });
  } catch (error) {
    console.error("getFilterOptions error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch filter options" });
  }
};
