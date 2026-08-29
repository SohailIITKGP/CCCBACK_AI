const mongoose = require("mongoose");
const todoService = require("../services/todoService");
const { loadTeamContext, TODO_ROLES } = require("../utils/todoAccess");
const { logDataAction, logFieldChange } = require("../utils/auditLogger");

const sendError = (res, error, fallback) => {
  const status = error.status || 500;
  if (status >= 500) console.error(fallback, error);
  return res.status(status).json({
    success: false,
    message: status >= 500 ? fallback : error.message,
  });
};

const withContext = async (req) => {
  if (!req.user) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
  if (!TODO_ROLES.includes(req.user.role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const teamCtx = await loadTeamContext(req.user._id);
  return { user: req.user, teamCtx };
};

exports.create = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    const todo = await todoService.createTodo(user, teamCtx, req.body || {});
    logDataAction(req, {
      action: "data_create",
      resource: "Todo",
      resourceId: todo._id,
      entityName: todo.title,
      details: { assignedTo: todo.assignedTo?.map((u) => u._id || u) },
    }).catch(() => {});
    return res.status(201).json({ success: true, todo });
  } catch (error) {
    return sendError(res, error, "Failed to create To-Do");
  }
};

exports.list = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    const result = await todoService.listTodos({ user, teamCtx, query: req.query });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, "Failed to fetch To-Dos");
  }
};

exports.summary = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    const summary = await todoService.getSummary(user, teamCtx);
    return res.status(200).json({ success: true, summary });
  } catch (error) {
    return sendError(res, error, "Failed to fetch summary");
  }
};

exports.dashboard = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    const data = await todoService.getDashboard(user, teamCtx);
    return res.status(200).json({ success: true, ...data });
  } catch (error) {
    return sendError(res, error, "Failed to fetch dashboard To-Dos");
  }
};

exports.calendar = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    const events = await todoService.getCalendarEvents(user, teamCtx, req.query);
    return res.status(200).json({ success: true, events });
  } catch (error) {
    return sendError(res, error, "Failed to fetch calendar");
  }
};

exports.performance = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    const reports = await todoService.getPerformance(user, teamCtx, req.query);
    return res.status(200).json({ success: true, reports });
  } catch (error) {
    return sendError(res, error, "Failed to fetch performance");
  }
};

exports.filterOptions = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    const options = await todoService.getFilterOptions(user, teamCtx);
    return res.status(200).json({ success: true, ...options });
  } catch (error) {
    return sendError(res, error, "Failed to fetch filter options");
  }
};

exports.crmSearch = async (req, res) => {
  try {
    const { user } = await withContext(req);
    const type = String(req.query.type || "").toUpperCase();
    const allowed = ["LEAD", "CLIENT", "OPPORTUNITY", "PROPERTY"];
    if (!allowed.includes(type)) {
      return res.status(400).json({ success: false, message: "Invalid CRM type" });
    }
    const results = await todoService.searchCrmEntities(user, {
      type,
      q: req.query.q,
    });
    return res.status(200).json({ success: true, results });
  } catch (error) {
    return sendError(res, error, "Failed to search CRM entities");
  }
};

exports.detail = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid To-Do id" });
    }
    const todo = await todoService.getTodoById(user, teamCtx, req.params.id);
    if (!todo) return res.status(404).json({ success: false, message: "To-Do not found" });
    return res.status(200).json({ success: true, todo });
  } catch (error) {
    return sendError(res, error, "Failed to fetch To-Do");
  }
};

exports.update = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid To-Do id" });
    }
    const todo = await todoService.updateTodo(user, teamCtx, req.params.id, req.body || {});
    logFieldChange(req, {
      resource: "Todo",
      resourceId: todo._id,
      entityName: todo.title,
      field: "todo",
      from: null,
      to: "updated",
    }).catch(() => {});
    return res.status(200).json({ success: true, todo });
  } catch (error) {
    return sendError(res, error, "Failed to update To-Do");
  }
};

exports.reassign = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid To-Do id" });
    }
    const todo = await todoService.reassignTodo(user, teamCtx, req.params.id, req.body || {});
    return res.status(200).json({ success: true, todo });
  } catch (error) {
    return sendError(res, error, "Failed to reassign To-Do");
  }
};

exports.start = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid To-Do id" });
    }
    const todo = await todoService.startTodo(user, teamCtx, req.params.id);
    return res.status(200).json({ success: true, todo });
  } catch (error) {
    return sendError(res, error, "Failed to start To-Do");
  }
};

exports.complete = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid To-Do id" });
    }
    const todo = await todoService.completeTodo(user, teamCtx, req.params.id, {
      note: req.body?.completionNote || req.body?.note,
    });
    logFieldChange(req, {
      resource: "Todo",
      resourceId: todo._id,
      entityName: todo.title,
      field: "status",
      from: "In Progress",
      to: "Completed",
      extra: { completionTiming: todo.timing?.completionTiming },
    }).catch(() => {});
    return res.status(200).json({ success: true, todo });
  } catch (error) {
    return sendError(res, error, "Failed to complete To-Do");
  }
};

exports.reopen = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid To-Do id" });
    }
    const todo = await todoService.reopenTodo(user, teamCtx, req.params.id);
    return res.status(200).json({ success: true, todo });
  } catch (error) {
    return sendError(res, error, "Failed to reopen To-Do");
  }
};

exports.cancel = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid To-Do id" });
    }
    const todo = await todoService.cancelTodo(user, teamCtx, req.params.id, {
      reason: req.body?.reason,
    });
    return res.status(200).json({ success: true, todo });
  } catch (error) {
    return sendError(res, error, "Failed to cancel To-Do");
  }
};

exports.comment = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid To-Do id" });
    }
    const todo = await todoService.addComment(user, teamCtx, req.params.id, {
      text: req.body?.text,
    });
    return res.status(200).json({ success: true, todo });
  } catch (error) {
    return sendError(res, error, "Failed to add comment");
  }
};

exports.attach = async (req, res) => {
  try {
    const { user, teamCtx } = await withContext(req);
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid To-Do id" });
    }
    const todo = await todoService.addAttachment(user, teamCtx, req.params.id, req.body || {});
    return res.status(200).json({ success: true, todo });
  } catch (error) {
    return sendError(res, error, "Failed to add attachment");
  }
};
