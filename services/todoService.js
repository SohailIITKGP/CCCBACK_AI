const mongoose = require("mongoose");
const WorkTodo = require("../models/WorkTodo");
const Team = require("../models/Team");
const User = require("../models/User");
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const Opportunity = require("../models/Opportunity");
const Property = require("../models/propertyModel");
const {
  STATUSES,
  PRIORITIES,
  SOURCE_TYPES,
  CATEGORIES,
  RECURRENCE_FREQUENCIES,
} = WorkTodo;
const { recordTodoActivity, listTodoActivities } = require("./todoActivityService");
const {
  deriveTodoTiming,
  computeCompletionFields,
  startOfDay,
  endOfDay,
  toDate,
} = require("../utils/todoTiming");
const {
  isManager,
  isGlobalAssigner,
  toId,
  uniqueIds,
  canViewTodo,
  canEditTodo,
  canChangeStatus,
  canComment,
  assertCanAssign,
  buildVisibilityFilter,
} = require("../utils/todoAccess");
const {
  createNotificationForUser,
} = require("../utils/notification");

const POPULATE = [
  { path: "owner", select: "name email role" },
  { path: "createdBy", select: "name email role" },
  { path: "assignedTo", select: "name email role" },
  { path: "assignedBy", select: "name email role" },
  { path: "collaborators", select: "name email role" },
  { path: "team", select: "name coordinator members" },
  { path: "completedBy", select: "name email role" },
  { path: "comments.author", select: "name email role" },
  { path: "attachments.uploadedBy", select: "name email role" },
];

const ALLOWED_SORT = {
  title: "title",
  priority: "priority",
  status: "status",
  createdAt: "createdAt",
  startAt: "startAt",
  dueAt: "dueAt",
  completedAt: "completedAt",
};

const MAX_PAGE_SIZE = 100;
const TITLE_MAX = 200;
const DESC_MAX = 10000;

function sanitizeText(value, max) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function sanitizeMultiline(value, max) {
  if (value == null) return "";
  return String(value).trim().slice(0, max);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isHttpsUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function reminderLabelFromOffset(minutes) {
  if (minutes === 30) return "30 minutes before";
  if (minutes === 60) return "1 hour before";
  if (minutes === 120) return "2 hours before";
  if (minutes === 1440) return "1 day before";
  if (minutes % 1440 === 0) return `${minutes / 1440} days before`;
  if (minutes % 60 === 0) return `${minutes / 60} hours before`;
  return `${minutes} minutes before`;
}

function normalizeReminders(input, dueAt) {
  if (!Array.isArray(input)) return [];
  const due = toDate(dueAt);
  const out = [];
  const seen = new Set();
  for (const item of input.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    if (item.kind === "absolute" && item.remindAt) {
      const at = parseDate(item.remindAt);
      if (!at) continue;
      const key = `abs:${at.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: "absolute",
        offsetMinutes: null,
        remindAt: at,
        label: sanitizeText(item.label, 80) || "Custom",
        sentAt: null,
      });
      continue;
    }
    const offset = Number(item.offsetMinutes);
    if (!Number.isFinite(offset) || offset < 0 || offset > 60 * 24 * 30) continue;
    const key = `rel:${offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: "relative",
      offsetMinutes: offset,
      remindAt: due ? new Date(due.getTime() - offset * 60 * 1000) : null,
      label: sanitizeText(item.label, 80) || reminderLabelFromOffset(offset),
      sentAt: null,
    });
  }
  return out;
}

function recomputeRelativeReminders(reminders, dueAt) {
  const due = toDate(dueAt);
  return (reminders || []).map((r) => {
    const row = typeof r.toObject === "function" ? r.toObject() : { ...r };
    if (row.kind === "relative" && due && row.offsetMinutes != null && !row.sentAt) {
      row.remindAt = new Date(due.getTime() - Number(row.offsetMinutes) * 60 * 1000);
    }
    return row;
  });
}

function deriveKind({ assignedTo, collaborators, team, createdBy }) {
  if (team) return "team";
  if ((collaborators || []).length) return "collaborative";
  const assignees = uniqueIds(assignedTo);
  if (assignees.length === 1 && assignees[0] === toId(createdBy)) return "personal";
  return "assigned";
}

async function resolveSource({ sourceType, sourceId }) {
  const type = SOURCE_TYPES.includes(sourceType) ? sourceType : "GENERAL";
  if (type === "GENERAL" || type === "PERSONAL" || !sourceId) {
    return { sourceType: type === "PERSONAL" ? "PERSONAL" : "GENERAL", sourceId: null, sourceName: "" };
  }
  if (!mongoose.isValidObjectId(sourceId)) {
    const err = new Error("Invalid CRM entity id");
    err.status = 400;
    throw err;
  }

  let sourceName = "";
  if (type === "LEAD") {
    const lead = await Lead.findById(sourceId).select("name").lean();
    if (!lead) {
      const err = new Error("Lead not found");
      err.status = 404;
      throw err;
    }
    sourceName = lead.name || "Lead";
  } else if (type === "CLIENT") {
    const client = await Client.findById(sourceId).select("name").lean();
    if (!client) {
      const err = new Error("Client not found");
      err.status = 404;
      throw err;
    }
    sourceName = client.name || "Client";
  } else if (type === "PROPERTY") {
    const property = await Property.findById(sourceId).select("name address").lean();
    if (!property) {
      const err = new Error("Property not found");
      err.status = 404;
      throw err;
    }
    sourceName = property.name || property.address || "Property";
  } else if (type === "OPPORTUNITY") {
    const opp = await Opportunity.findById(sourceId)
      .populate("client", "name")
      .populate("property", "name")
      .select("client property status")
      .lean();
    if (!opp) {
      const err = new Error("Opportunity not found");
      err.status = 404;
      throw err;
    }
    const clientName = opp.client?.name || "Client";
    const propertyName = opp.property?.name || "Property";
    sourceName = `${clientName} — ${propertyName}`;
  }

  return { sourceType: type, sourceId, sourceName };
}

function enrichTodo(todo, now = new Date()) {
  const row = todo && typeof todo.toObject === "function" ? todo.toObject() : { ...todo };
  const timing = deriveTodoTiming(row, now);
  return {
    ...row,
    kind: deriveKind(row),
    originalDueAt: row.originalDueAt || row.dueAt || null,
    timing,
  };
}

async function populateTodo(todo) {
  if (!todo) return null;
  return WorkTodo.findById(todo._id).populate(POPULATE);
}

function notifyQuietly(payload) {
  createNotificationForUser(payload).catch((err) => {
    console.error("[todo] notification failed:", err.message);
  });
}

function notifyMany(userIds, payload) {
  const unique = uniqueIds(userIds);
  unique.forEach((id) => {
    notifyQuietly({ ...payload, recipientUserId: id });
  });
}

async function createTodo(user, teamCtx, body) {
  const title = sanitizeText(body.title, TITLE_MAX);
  if (!title) {
    const err = new Error("Title is required");
    err.status = 400;
    throw err;
  }

  const assignedToIds = uniqueIds(body.assignedTo);
  const teamId = body.team && mongoose.isValidObjectId(body.team) ? String(body.team) : null;
  const assignCheck = await assertCanAssign({
    user,
    assignedToIds: assignedToIds.length ? assignedToIds : [toId(user._id)],
    teamId,
    teamCtx,
  });
  if (!assignCheck.ok) {
    const err = new Error(assignCheck.message);
    err.status = assignCheck.status;
    throw err;
  }

  const collaborators = uniqueIds(body.collaborators).filter(
    (id) => !assignCheck.targets.includes(id)
  );
  const dueAt = parseDate(body.dueAt);
  const startAt = parseDate(body.startAt);
  if (startAt && dueAt && startAt.getTime() > dueAt.getTime()) {
    const err = new Error("Start date cannot be after the deadline");
    err.status = 400;
    throw err;
  }

  const source = await resolveSource({
    sourceType: body.sourceType,
    sourceId: body.sourceId,
  });

  const recurrence = {
    enabled: Boolean(body.recurrence?.enabled),
    frequency: RECURRENCE_FREQUENCIES.includes(body.recurrence?.frequency)
      ? body.recurrence.frequency
      : "none",
    interval: Math.min(30, Math.max(1, Number(body.recurrence?.interval) || 1)),
    daysOfWeek: Array.isArray(body.recurrence?.daysOfWeek)
      ? body.recurrence.daysOfWeek.map(Number).filter((d) => d >= 0 && d <= 6).slice(0, 7)
      : [],
    dayOfMonth: body.recurrence?.dayOfMonth
      ? Math.min(31, Math.max(1, Number(body.recurrence.dayOfMonth)))
      : null,
    until: parseDate(body.recurrence?.until),
  };
  if (!recurrence.enabled) recurrence.frequency = "none";

  const isSelf =
    assignCheck.targets.length === 1 && assignCheck.targets[0] === toId(user._id);
  const assignedBy = isSelf && !teamId ? user._id : user._id;
  const assignedAt = new Date();

  const todo = await WorkTodo.create({
    title,
    description: sanitizeMultiline(body.description, DESC_MAX),
    status: "To Do",
    priority: PRIORITIES.includes(body.priority) ? body.priority : "Medium",
    category: CATEGORIES.includes(body.category) ? body.category : "General",
    owner: mongoose.isValidObjectId(body.owner) ? body.owner : assignCheck.targets[0] || user._id,
    createdBy: user._id,
    assignedTo: assignCheck.targets,
    assignedBy,
    assignedAt,
    collaborators,
    team: teamId,
    startAt,
    dueAt,
    originalDueAt: dueAt,
    reminders: normalizeReminders(body.reminders, dueAt),
    recurrence,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    sourceName: source.sourceName,
  });

  await recordTodoActivity({
    eventType: "task_created",
    todoId: todo._id,
    performedBy: user._id,
    newValue: { title, dueAt, assignedTo: assignCheck.targets, team: teamId },
  });

  if (!isSelf) {
    await recordTodoActivity({
      eventType: "task_assigned",
      todoId: todo._id,
      performedBy: user._id,
      newValue: { assignedTo: assignCheck.targets },
    });
    notifyMany(
      assignCheck.targets.filter((id) => id !== toId(user._id)),
      {
        type: "Todo",
        action: "Assigned",
        entityId: todo._id,
        entityName: title,
        message: `${user.name} assigned you "${title}"`,
        category: "todo_assigned",
        severity: "info",
        meta: { path: `/todos?id=${todo._id}` },
      }
    );
  }

  if (collaborators.length) {
    notifyMany(
      collaborators.filter((id) => id !== toId(user._id)),
      {
        type: "Todo",
        action: "Collaborator",
        entityId: todo._id,
        entityName: title,
        message: `${user.name} added you as a collaborator on "${title}"`,
        category: "todo_collaborator",
        meta: { path: `/todos?id=${todo._id}` },
      }
    );
  }

  if (todo.reminders?.length) {
    await recordTodoActivity({
      eventType: "reminder_created",
      todoId: todo._id,
      performedBy: user._id,
      newValue: todo.reminders.map((r) => ({ label: r.label, remindAt: r.remindAt })),
    });
  }

  if (recurrence.enabled && recurrence.frequency !== "none") {
    const { generateUpcomingOccurrences } = require("./todoRecurrenceService");
    await generateUpcomingOccurrences(todo, { lookaheadDays: 28, actorId: user._id });
  }

  const populated = await populateTodo(todo);
  return enrichTodo(populated);
}

function buildTabFilter(tab, now = new Date()) {
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const open = { $in: ["To Do", "In Progress"] };

  if (tab === "today") {
    return {
      status: open,
      dueAt: { $gte: todayStart, $lte: todayEnd },
    };
  }
  if (tab === "upcoming") {
    return {
      status: open,
      dueAt: { $gt: todayEnd },
    };
  }
  if (tab === "overdue") {
    return {
      status: open,
      dueAt: { $lt: todayStart, $ne: null },
    };
  }
  if (tab === "completed") {
    return { status: "Completed" };
  }
  if (tab === "in_progress") {
    return { status: "In Progress" };
  }
  if (tab === "assigned_by_me") {
    return {};
  }
  if (tab === "team") {
    return { team: { $ne: null } };
  }
  if (tab === "my" || tab === "all") {
    return {};
  }
  return {};
}

function buildListFilters({
  q,
  status,
  priority,
  assignedTo,
  assignedBy,
  team,
  dueFrom,
  dueTo,
  createdFrom,
  createdTo,
  category,
  sourceType,
  crmLinked,
  completedLate,
  overdue,
  now,
}) {
  const filters = {};
  if (status && STATUSES.includes(status)) filters.status = status;
  if (priority && PRIORITIES.includes(priority)) filters.priority = priority;
  if (category && CATEGORIES.includes(category)) filters.category = category;
  if (assignedTo && mongoose.isValidObjectId(assignedTo)) filters.assignedTo = assignedTo;
  if (assignedBy && mongoose.isValidObjectId(assignedBy)) filters.assignedBy = assignedBy;
  if (team && mongoose.isValidObjectId(team)) filters.team = team;
  if (sourceType && SOURCE_TYPES.includes(sourceType)) filters.sourceType = sourceType;
  if (crmLinked === "true") filters.sourceType = { $in: ["LEAD", "CLIENT", "OPPORTUNITY", "PROPERTY"] };
  if (crmLinked === "false") filters.sourceType = { $in: ["GENERAL", "PERSONAL"] };

  if (dueFrom || dueTo) {
    filters.dueAt = {};
    if (dueFrom) filters.dueAt.$gte = parseDate(dueFrom) || undefined;
    if (dueTo) filters.dueAt.$lte = endOfDay(parseDate(dueTo) || new Date());
  }
  if (createdFrom || createdTo) {
    filters.createdAt = {};
    if (createdFrom) filters.createdAt.$gte = parseDate(createdFrom) || undefined;
    if (createdTo) filters.createdAt.$lte = endOfDay(parseDate(createdTo) || new Date());
  }

  if (overdue === "true") {
    filters.status = { $in: ["To Do", "In Progress"] };
    filters.dueAt = { ...(filters.dueAt || {}), $lt: now, $ne: null };
  }
  if (completedLate === "true") {
    filters.status = "Completed";
    filters.completionTiming = "late";
  }

  if (q && String(q).trim()) {
    const rx = new RegExp(escapeRegex(String(q).trim()), "i");
    filters.$and = (filters.$and || []).concat([
      {
        $or: [
          { title: rx },
          { description: rx },
          { sourceName: rx },
        ],
      },
    ]);
  }

  return filters;
}

async function listTodos({ user, teamCtx, query }) {
  const now = new Date();
  const tab = String(query.tab || "my");
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.limit, 10) || 25));
  const sortBy = ALLOWED_SORT[query.sortBy] || "dueAt";
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;

  const myScope = {
    $or: [
      { assignedTo: user._id },
      { owner: user._id },
      { collaborators: user._id },
    ],
  };
  const myTabs = new Set(["my", "today", "upcoming", "overdue", "completed", "in_progress"]);
  let visibility = buildVisibilityFilter(user, teamCtx, { tab });
  const managerWideTabs = new Set(["today", "upcoming", "overdue", "completed", "in_progress", "all"]);
  if (isManager(user) && managerWideTabs.has(tab)) {
    visibility = {};
  } else if (tab === "assigned_by_me") {
    visibility = { assignedBy: user._id };
  } else if (myTabs.has(tab)) {
    visibility = myScope;
  } else if (tab === "team") {
    const teamIds = [
      ...(teamCtx.coordinatedTeamIds || []),
      ...(teamCtx.memberTeamIds || []),
    ];
    if (isManager(user)) {
      visibility = { team: { $ne: null } };
    } else if (teamIds.length) {
      visibility = { team: { $in: teamIds.map((id) => new mongoose.Types.ObjectId(id)) } };
    } else {
      visibility = { _id: { $in: [] } };
    }
  }

  const tabFilter = buildTabFilter(tab, now);
  const extra = buildListFilters({ ...query, now });

  if (query.employeeId && isManager(user) && mongoose.isValidObjectId(query.employeeId)) {
    extra.assignedTo = query.employeeId;
  }

  const parts = [visibility, tabFilter, extra].filter((f) => Object.keys(f).length);
  const mongoQuery = parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };

  const [rows, total] = await Promise.all([
    WorkTodo.find(mongoQuery)
      .populate(POPULATE)
      .sort({ [sortBy]: sortOrder, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    WorkTodo.countDocuments(mongoQuery),
  ]);

  return {
    data: rows.map((row) => enrichTodo(row, now)),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    },
  };
}

async function getTodoById(user, teamCtx, id) {
  const todo = await WorkTodo.findById(id).populate(POPULATE);
  if (!todo) return null;
  if (!canViewTodo(user, todo, teamCtx)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const activities = await listTodoActivities(id);
  return { ...enrichTodo(todo), activities };
}

async function updateTodo(user, teamCtx, id, body) {
  const todo = await WorkTodo.findById(id);
  if (!todo) {
    const err = new Error("To-Do not found");
    err.status = 404;
    throw err;
  }
  if (!canEditTodo(user, todo, teamCtx)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  if (todo.status === "Cancelled") {
    const err = new Error("Cancelled To-Dos cannot be edited");
    err.status = 400;
    throw err;
  }

  if (body.title != null) {
    const title = sanitizeText(body.title, TITLE_MAX);
    if (!title) {
      const err = new Error("Title is required");
      err.status = 400;
      throw err;
    }
    if (title !== todo.title) {
      todo.title = title;
    }
  }
  if (body.description != null) {
    todo.description = sanitizeMultiline(body.description, DESC_MAX);
  }
  if (body.priority && PRIORITIES.includes(body.priority) && body.priority !== todo.priority) {
    await recordTodoActivity({
      eventType: "priority_changed",
      todoId: todo._id,
      performedBy: user._id,
      previousValue: todo.priority,
      newValue: body.priority,
    });
    todo.priority = body.priority;
  }
  if (body.category && CATEGORIES.includes(body.category)) {
    todo.category = body.category;
  }

  if (body.dueAt !== undefined) {
    const nextDue = parseDate(body.dueAt);
    if (String(todo.dueAt || "") !== String(nextDue || "")) {
      await recordTodoActivity({
        eventType: "deadline_changed",
        todoId: todo._id,
        performedBy: user._id,
        previousValue: todo.dueAt,
        newValue: nextDue,
      });
      notifyMany(
        uniqueIds([...(todo.assignedTo || []), todo.owner]).filter((id) => id !== toId(user._id)),
        {
          type: "Todo",
          action: "Deadline Changed",
          entityId: todo._id,
          entityName: todo.title,
          message: `Deadline for "${todo.title}" was changed`,
          category: "todo_deadline",
          severity: "warning",
          meta: { path: `/todos?id=${todo._id}` },
        }
      );
      todo.dueAt = nextDue;
      if (!todo.originalDueAt && nextDue) todo.originalDueAt = nextDue;
      todo.reminders = recomputeRelativeReminders(todo.reminders, nextDue);
    }
  }

  if (body.startAt !== undefined) {
    const nextStart = parseDate(body.startAt);
    if (nextStart && todo.dueAt && nextStart.getTime() > new Date(todo.dueAt).getTime()) {
      const err = new Error("Start date cannot be after the deadline");
      err.status = 400;
      throw err;
    }
    if (String(todo.startAt || "") !== String(nextStart || "")) {
      await recordTodoActivity({
        eventType: "task_rescheduled",
        todoId: todo._id,
        performedBy: user._id,
        previousValue: { startAt: todo.startAt, dueAt: todo.dueAt },
        newValue: { startAt: nextStart, dueAt: todo.dueAt },
      });
      todo.startAt = nextStart;
    }
  }

  if (body.reminders) {
    todo.reminders = normalizeReminders(body.reminders, todo.dueAt);
    await recordTodoActivity({
      eventType: "reminder_created",
      todoId: todo._id,
      performedBy: user._id,
      newValue: todo.reminders.map((r) => ({ label: r.label, remindAt: r.remindAt })),
    });
  }

  if (body.sourceType !== undefined) {
    const source = await resolveSource({
      sourceType: body.sourceType,
      sourceId: body.sourceId,
    });
    if (source.sourceType !== todo.sourceType || String(source.sourceId) !== String(todo.sourceId || "")) {
      await recordTodoActivity({
        eventType: "crm_link_changed",
        todoId: todo._id,
        performedBy: user._id,
        previousValue: { sourceType: todo.sourceType, sourceId: todo.sourceId },
        newValue: source,
      });
      todo.sourceType = source.sourceType;
      todo.sourceId = source.sourceId;
      todo.sourceName = source.sourceName;
    }
  }

  if (body.collaborators) {
    const next = uniqueIds(body.collaborators);
    await recordTodoActivity({
      eventType: "collaborators_changed",
      todoId: todo._id,
      performedBy: user._id,
      previousValue: todo.collaborators,
      newValue: next,
    });
    todo.collaborators = next;
  }

  await todo.save();
  const populated = await populateTodo(todo);
  return enrichTodo(populated);
}

async function reassignTodo(user, teamCtx, id, body) {
  const todo = await WorkTodo.findById(id);
  if (!todo) {
    const err = new Error("To-Do not found");
    err.status = 404;
    throw err;
  }
  if (!canEditTodo(user, todo, teamCtx) && !isGlobalAssigner(user)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  const assignedToIds = uniqueIds(body.assignedTo);
  const teamId = body.team !== undefined
    ? (body.team && mongoose.isValidObjectId(body.team) ? String(body.team) : null)
    : toId(todo.team) || null;

  const assignCheck = await assertCanAssign({
    user,
    assignedToIds,
    teamId,
    teamCtx,
  });
  if (!assignCheck.ok) {
    const err = new Error(assignCheck.message);
    err.status = assignCheck.status;
    throw err;
  }
  if (!assignCheck.targets.length) {
    const err = new Error("At least one assignee is required");
    err.status = 400;
    throw err;
  }

  const previous = uniqueIds(todo.assignedTo);
  todo.assignedTo = assignCheck.targets;
  todo.assignedBy = user._id;
  todo.assignedAt = new Date();
  if (body.team !== undefined) todo.team = teamId;
  if (!todo.owner) todo.owner = assignCheck.targets[0];
  await todo.save();

  await recordTodoActivity({
    eventType: "task_reassigned",
    todoId: todo._id,
    performedBy: user._id,
    previousValue: previous,
    newValue: assignCheck.targets,
  });

  notifyMany(
    assignCheck.targets.filter((idStr) => idStr !== toId(user._id)),
    {
      type: "Todo",
      action: "Reassigned",
      entityId: todo._id,
      entityName: todo.title,
      message: `${user.name} reassigned "${todo.title}" to you`,
      category: "todo_reassigned",
      severity: "info",
      meta: { path: `/todos?id=${todo._id}` },
    }
  );

  const populated = await populateTodo(todo);
  return enrichTodo(populated);
}

async function startTodo(user, teamCtx, id) {
  const todo = await WorkTodo.findById(id);
  if (!todo) {
    const err = new Error("To-Do not found");
    err.status = 404;
    throw err;
  }
  if (!canChangeStatus(user, todo, teamCtx)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  if (todo.status === "Completed" || todo.status === "Cancelled") {
    const err = new Error("This To-Do cannot be started");
    err.status = 400;
    throw err;
  }
  if (todo.status === "In Progress" && todo.startedAt) {
    const populated = await populateTodo(todo);
    return enrichTodo(populated);
  }

  const previous = todo.status;
  todo.status = "In Progress";
  if (!todo.startedAt) todo.startedAt = new Date();
  await todo.save();

  await recordTodoActivity({
    eventType: "task_started",
    todoId: todo._id,
    performedBy: user._id,
    previousValue: previous,
    newValue: "In Progress",
    metadata: { startedAt: todo.startedAt },
  });

  const populated = await populateTodo(todo);
  return enrichTodo(populated);
}

async function completeTodo(user, teamCtx, id, { note } = {}) {
  const todo = await WorkTodo.findById(id);
  if (!todo) {
    const err = new Error("To-Do not found");
    err.status = 404;
    throw err;
  }
  if (!canChangeStatus(user, todo, teamCtx)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  if (todo.status === "Completed") {
    const err = new Error("To-Do already completed");
    err.status = 400;
    throw err;
  }
  if (todo.status === "Cancelled") {
    const err = new Error("Cancelled To-Dos cannot be completed");
    err.status = 400;
    throw err;
  }

  const previous = todo.status;
  const fields = computeCompletionFields(todo, new Date());
  todo.status = "Completed";
  todo.completedAt = fields.completedAt;
  todo.completionTiming = fields.completionTiming;
  todo.completedBy = user._id;
  todo.completionNote = sanitizeMultiline(note, 2000);
  if (!todo.startedAt) todo.startedAt = fields.completedAt;
  await todo.save();

  await recordTodoActivity({
    eventType: "task_completed",
    todoId: todo._id,
    performedBy: user._id,
    previousValue: previous,
    newValue: {
      status: "Completed",
      completedAt: todo.completedAt,
      completionTiming: todo.completionTiming,
    },
    metadata: { note: todo.completionNote },
  });

  if (todo.assignedBy && toId(todo.assignedBy) !== toId(user._id)) {
    notifyQuietly({
      recipientUserId: todo.assignedBy,
      type: "Todo",
      action: "Completed",
      entityId: todo._id,
      entityName: todo.title,
      message: `${user.name} completed "${todo.title}"`,
      category: "todo_completed",
      meta: { path: `/todos?id=${todo._id}` },
    });
  }

  if (todo.recurrence?.enabled && !todo.parentTodoId) {
    const { generateUpcomingOccurrences } = require("./todoRecurrenceService");
    await generateUpcomingOccurrences(todo, { lookaheadDays: 28, actorId: user._id });
  }

  const populated = await populateTodo(todo);
  return enrichTodo(populated);
}

async function reopenTodo(user, teamCtx, id) {
  const todo = await WorkTodo.findById(id);
  if (!todo) {
    const err = new Error("To-Do not found");
    err.status = 404;
    throw err;
  }
  if (!canEditTodo(user, todo, teamCtx) && !canChangeStatus(user, todo, teamCtx)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  if (todo.status !== "Completed" && todo.status !== "Cancelled") {
    const err = new Error("Only completed or cancelled To-Dos can be reopened");
    err.status = 400;
    throw err;
  }

  const previous = todo.status;
  todo.status = todo.startedAt ? "In Progress" : "To Do";
  todo.completedAt = null;
  todo.completionTiming = null;
  todo.completedBy = null;
  todo.cancelledAt = null;
  await todo.save();

  await recordTodoActivity({
    eventType: "task_reopened",
    todoId: todo._id,
    performedBy: user._id,
    previousValue: previous,
    newValue: todo.status,
  });

  const populated = await populateTodo(todo);
  return enrichTodo(populated);
}

async function cancelTodo(user, teamCtx, id, { reason } = {}) {
  const todo = await WorkTodo.findById(id);
  if (!todo) {
    const err = new Error("To-Do not found");
    err.status = 404;
    throw err;
  }
  if (!canEditTodo(user, todo, teamCtx) && !isManager(user)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  if (todo.status === "Cancelled") {
    const populated = await populateTodo(todo);
    return enrichTodo(populated);
  }

  const previous = todo.status;
  todo.status = "Cancelled";
  todo.cancelledAt = new Date();
  await todo.save();

  await recordTodoActivity({
    eventType: "task_cancelled",
    todoId: todo._id,
    performedBy: user._id,
    previousValue: previous,
    newValue: "Cancelled",
    metadata: { reason: sanitizeText(reason, 500) },
  });

  const populated = await populateTodo(todo);
  return enrichTodo(populated);
}

async function addComment(user, teamCtx, id, { text }) {
  const todo = await WorkTodo.findById(id);
  if (!todo) {
    const err = new Error("To-Do not found");
    err.status = 404;
    throw err;
  }
  if (!canComment(user, todo, teamCtx)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const body = sanitizeMultiline(text, 4000);
  if (!body) {
    const err = new Error("Comment text is required");
    err.status = 400;
    throw err;
  }

  const mentionIds = uniqueIds((body.match(/@\[([a-f0-9]{24})\]/gi) || []).map((m) => m.slice(2, -1)));
  todo.comments.push({
    text: body,
    author: user._id,
    mentions: mentionIds,
    createdAt: new Date(),
  });
  await todo.save();

  await recordTodoActivity({
    eventType: "comment_added",
    todoId: todo._id,
    performedBy: user._id,
    newValue: { text: body.slice(0, 200) },
  });

  const recipients = uniqueIds([
    ...(todo.assignedTo || []),
    todo.owner,
    todo.assignedBy,
    ...(todo.collaborators || []),
    ...mentionIds,
  ]).filter((uid) => uid !== toId(user._id));

  notifyMany(recipients, {
    type: "Todo",
    action: mentionIds.length ? "Mentioned" : "Comment",
    entityId: todo._id,
    entityName: todo.title,
    message: `${user.name} commented on "${todo.title}"`,
    category: mentionIds.length ? "todo_mention" : "todo_comment",
    meta: { path: `/todos?id=${todo._id}` },
  });

  const populated = await populateTodo(todo);
  return enrichTodo(populated);
}

async function addAttachment(user, teamCtx, id, { name, url, mimeType, size }) {
  const todo = await WorkTodo.findById(id);
  if (!todo) {
    const err = new Error("To-Do not found");
    err.status = 404;
    throw err;
  }
  if (!canComment(user, todo, teamCtx)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const fileName = sanitizeText(name, 255);
  if (!fileName || !isHttpsUrl(url)) {
    const err = new Error("A valid file name and http(s) URL are required");
    err.status = 400;
    throw err;
  }
  if ((todo.attachments || []).length >= 20) {
    const err = new Error("Attachment limit reached");
    err.status = 400;
    throw err;
  }

  todo.attachments.push({
    name: fileName,
    url: String(url).slice(0, 2000),
    mimeType: sanitizeText(mimeType, 120),
    size: Number.isFinite(Number(size)) ? Number(size) : null,
    uploadedBy: user._id,
    uploadedAt: new Date(),
  });
  await todo.save();

  await recordTodoActivity({
    eventType: "attachment_added",
    todoId: todo._id,
    performedBy: user._id,
    newValue: { name: fileName },
  });

  const populated = await populateTodo(todo);
  return enrichTodo(populated);
}

async function getSummary(user, teamCtx) {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const mine = {
    $or: [
      { assignedTo: user._id },
      { owner: user._id },
      { collaborators: user._id },
    ],
  };
  const open = { status: { $in: ["To Do", "In Progress"] } };

  const [today, inProgress, upcoming, overdue, completed] = await Promise.all([
    WorkTodo.countDocuments({ ...mine, ...open, dueAt: { $gte: todayStart, $lte: todayEnd } }),
    WorkTodo.countDocuments({ ...mine, status: "In Progress" }),
    WorkTodo.countDocuments({ ...mine, ...open, dueAt: { $gt: todayEnd } }),
    WorkTodo.countDocuments({ ...mine, ...open, dueAt: { $lt: todayStart, $ne: null } }),
    WorkTodo.countDocuments({ ...mine, status: "Completed" }),
  ]);

  return { today, inProgress, upcoming, overdue, completed };
}

async function getCalendarEvents(user, teamCtx, { from, to } = {}) {
  const now = new Date();
  const rangeStart = parseDate(from) || startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
  const rangeEnd = parseDate(to) || endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const visibility = buildVisibilityFilter(user, teamCtx, { tab: isManager(user) ? "all" : "my" });

  const rows = await WorkTodo.find({
    $and: [
      visibility,
      { status: { $ne: "Cancelled" } },
      {
        $or: [
          { dueAt: { $gte: rangeStart, $lte: rangeEnd } },
          { startAt: { $gte: rangeStart, $lte: rangeEnd } },
          { "reminders.remindAt": { $gte: rangeStart, $lte: rangeEnd } },
        ],
      },
    ],
  })
    .populate("assignedTo", "name")
    .populate("assignedBy", "name")
    .select("title status priority startAt dueAt reminders assignedTo assignedBy team")
    .lean();

  const events = [];
  for (const row of rows) {
    const timing = deriveTodoTiming(row, now);
    const assignee = (row.assignedTo || []).map((u) => u.name).filter(Boolean).join(", ");
    const assignedBy = row.assignedBy?.name;
    if (row.startAt) {
      events.push({
        id: `${row._id}-start`,
        todoId: row._id,
        title: row.title,
        start: row.startAt,
        kind: "start",
        status: timing.displayStatus,
        priority: row.priority,
        assignedTo: assignee,
        assignedBy,
      });
    }
    if (row.dueAt) {
      events.push({
        id: `${row._id}-due`,
        todoId: row._id,
        title: `${row.title} (Deadline)`,
        start: row.dueAt,
        kind: "deadline",
        status: timing.displayStatus,
        priority: row.priority,
        assignedTo: assignee,
        assignedBy,
      });
    }
    for (const reminder of row.reminders || []) {
      if (!reminder.remindAt) continue;
      const at = new Date(reminder.remindAt);
      if (at < rangeStart || at > rangeEnd) continue;
      events.push({
        id: `${row._id}-rem-${reminder._id}`,
        todoId: row._id,
        title: `${row.title} (Reminder)`,
        start: reminder.remindAt,
        kind: "reminder",
        status: timing.displayStatus,
        priority: row.priority,
        assignedTo: assignee,
        assignedBy,
      });
    }
  }
  return events;
}

async function getDashboard(user, teamCtx) {
  const now = new Date();
  const summary = await getSummary(user, teamCtx);
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);
  const visibility = {
    $or: [
      { assignedTo: user._id },
      { owner: user._id },
      { collaborators: user._id },
    ],
  };

  const rows = await WorkTodo.find({
    $and: [
      visibility,
      { status: { $ne: "Cancelled" } },
      {
        $or: [
          { dueAt: { $gte: todayStart, $lte: todayEnd } },
          { startAt: { $gte: todayStart, $lte: todayEnd } },
          { "reminders.remindAt": { $gte: todayStart, $lte: todayEnd } },
        ],
      },
    ],
  })
    .populate("assignedTo", "name")
    .populate("assignedBy", "name")
    .select("title status priority startAt dueAt reminders assignedTo assignedBy completionTiming completedAt")
    .lean();

  const schedule = [];
  for (const row of rows) {
    const timing = deriveTodoTiming(row, now);
    const push = (at, kind, label) => {
      if (!at) return;
      const d = new Date(at);
      if (d < todayStart || d > todayEnd) return;
      schedule.push({
        todoId: row._id,
        title: label,
        at,
        kind,
        status: timing.displayStatus,
        priority: row.priority,
        assignedBy: row.assignedBy?.name || "",
      });
    };
    push(row.startAt, "start", row.title);
    push(row.dueAt, "deadline", `${row.title} (Deadline)`);
    for (const rem of row.reminders || []) {
      push(rem.remindAt, "reminder", `${row.title} (Reminder)`);
    }
  }
  schedule.sort((a, b) => new Date(a.at) - new Date(b.at));

  return { summary, schedule };
}

async function getPerformance(user, teamCtx, query) {
  if (!isManager(user) && !isGlobalAssigner(user) && !(teamCtx.coordinatedTeamIds || []).length) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  const from = parseDate(query.from) || startOfDay(new Date(Date.now() - 30 * 86400000));
  const to = parseDate(query.to) || endOfDay(new Date());
  const match = {
    createdAt: { $gte: from, $lte: to },
  };
  if (query.employeeId && mongoose.isValidObjectId(query.employeeId)) {
    match.assignedTo = new mongoose.Types.ObjectId(query.employeeId);
  }
  if (query.team && mongoose.isValidObjectId(query.team)) {
    if (
      !isManager(user) &&
      !isGlobalAssigner(user) &&
      !(teamCtx.coordinatedTeamIds || []).includes(String(query.team))
    ) {
      const err = new Error("Forbidden");
      err.status = 403;
      throw err;
    }
    match.team = new mongoose.Types.ObjectId(query.team);
  } else if (!isManager(user) && !isGlobalAssigner(user)) {
    match.team = {
      $in: (teamCtx.coordinatedTeamIds || []).map((id) => new mongoose.Types.ObjectId(id)),
    };
  }
  if (query.priority && PRIORITIES.includes(query.priority)) match.priority = query.priority;
  if (query.category && CATEGORIES.includes(query.category)) match.category = query.category;
  if (query.status && STATUSES.includes(query.status)) match.status = query.status;

  const todos = await WorkTodo.find(match)
    .select("assignedTo status dueAt completedAt completionTiming createdAt startedAt assignedAt priority category")
    .lean();

  const now = new Date();
  const byUser = new Map();
  const weekly = new Map();

  const bump = (uid, field, amount = 1) => {
    if (!byUser.has(uid)) {
      byUser.set(uid, {
        userId: uid,
        assigned: 0,
        completed: 0,
        onTime: 0,
        completedLate: 0,
        pending: 0,
        overdue: 0,
      });
    }
    byUser.get(uid)[field] += amount;
  };

  for (const todo of todos) {
    const timing = deriveTodoTiming(todo, now);
    const assignees = uniqueIds(todo.assignedTo);
    const people = assignees.length ? assignees : ["unassigned"];
    for (const uid of people) {
      bump(uid, "assigned");
      if (todo.status === "Completed") {
        bump(uid, "completed");
        if (timing.completionTiming === "on_time") bump(uid, "onTime");
        else if (timing.completionTiming === "late") bump(uid, "completedLate");
      } else if (todo.status !== "Cancelled") {
        bump(uid, "pending");
        if (timing.isOverdue) bump(uid, "overdue");
      }
    }

    if (todo.status === "Completed" && todo.completedAt) {
      const d = new Date(todo.completedAt);
      const weekStart = new Date(d);
      const day = weekStart.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      weekStart.setDate(weekStart.getDate() + mondayOffset);
      weekStart.setHours(0, 0, 0, 0);
      const key = weekStart.toISOString().slice(0, 10);
      if (!weekly.has(key)) weekly.set(key, { week: key, completed: 0, onTime: 0, late: 0 });
      const bucket = weekly.get(key);
      bucket.completed += 1;
      if (timing.completionTiming === "on_time") bucket.onTime += 1;
      if (timing.completionTiming === "late") bucket.late += 1;
    }
  }

  const userIds = [...byUser.keys()].filter((id) => mongoose.isValidObjectId(id));
  const users = await User.find({ _id: { $in: userIds } }).select("name role").lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  const employees = [...byUser.values()]
    .filter((row) => mongoose.isValidObjectId(row.userId))
    .map((row) => {
      const person = userMap.get(row.userId);
      const completionRate = row.assigned ? (row.completed / row.assigned) * 100 : 0;
      const onTimeRate = row.completed ? (row.onTime / row.completed) * 100 : 0;
      const lateRate = row.completed ? (row.completedLate / row.completed) * 100 : 0;
      return {
        ...row,
        name: person?.name || "Unknown",
        role: person?.role || "",
        completionRate: Math.round(completionRate * 10) / 10,
        onTimeRate: Math.round(onTimeRate * 10) / 10,
        lateRate: Math.round(lateRate * 10) / 10,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const totals = employees.reduce(
    (acc, row) => {
      acc.assigned += row.assigned;
      acc.completed += row.completed;
      acc.onTime += row.onTime;
      acc.completedLate += row.completedLate;
      acc.pending += row.pending;
      acc.overdue += row.overdue;
      return acc;
    },
    { assigned: 0, completed: 0, onTime: 0, completedLate: 0, pending: 0, overdue: 0 }
  );
  totals.completionRate = totals.assigned ? Math.round((totals.completed / totals.assigned) * 1000) / 10 : 0;
  totals.onTimeRate = totals.completed ? Math.round((totals.onTime / totals.completed) * 1000) / 10 : 0;
  totals.lateRate = totals.completed ? Math.round((totals.completedLate / totals.completed) * 1000) / 10 : 0;

  const trends = [...weekly.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((row) => ({
      ...row,
      onTimeRate: row.completed ? Math.round((row.onTime / row.completed) * 1000) / 10 : 0,
    }));

  return { from, to, totals, employees, trends };
}

async function getFilterOptions(user, teamCtx) {
  const visibility = buildVisibilityFilter(user, teamCtx, { tab: isManager(user) ? "all" : "my" });
  const [users, teams] = await Promise.all([
    User.find({ status: "Active" }).select("name role").sort({ name: 1 }).lean(),
    Team.find(
      isManager(user)
        ? { status: "Active" }
        : {
            status: "Active",
            $or: [{ coordinator: user._id }, { members: user._id }],
          }
    )
      .select("name coordinator members")
      .sort({ name: 1 })
      .lean(),
  ]);
  return {
    employees: users,
    teams,
    statuses: STATUSES,
    priorities: PRIORITIES,
    categories: CATEGORIES,
    sourceTypes: SOURCE_TYPES,
    canAssign: isGlobalAssigner(user) || (teamCtx.coordinatedTeamIds || []).length > 0,
    canManageTeams: isGlobalAssigner(user),
    isManager: isManager(user),
    visibilityUsed: Boolean(visibility),
  };
}

async function searchCrmEntities(_user, { type, q }) {
  const query = sanitizeText(q, 80);
  if (!query || query.length < 2) return [];
  const rx = new RegExp(escapeRegex(query), "i");
  const limit = 12;

  if (type === "LEAD") {
    const rows = await Lead.find({ name: rx }).select("name status").limit(limit).lean();
    return rows.map((r) => ({ id: r._id, name: r.name, extra: r.status, type: "LEAD" }));
  }
  if (type === "CLIENT") {
    const rows = await Client.find({ name: rx }).select("name").limit(limit).lean();
    return rows.map((r) => ({ id: r._id, name: r.name, extra: "", type: "CLIENT" }));
  }
  if (type === "PROPERTY") {
    const rows = await Property.find({
      $or: [{ name: rx }, { address: rx }],
    })
      .select("name address")
      .limit(limit)
      .lean();
    return rows.map((r) => ({
      id: r._id,
      name: r.name || r.address || "Property",
      extra: r.address || "",
      type: "PROPERTY",
    }));
  }
  if (type === "OPPORTUNITY") {
    const clients = await Client.find({ name: rx }).select("_id name").limit(20).lean();
    const properties = await Property.find({ name: rx }).select("_id name").limit(20).lean();
    const rows = await Opportunity.find({
      $or: [
        { client: { $in: clients.map((c) => c._id) } },
        { property: { $in: properties.map((p) => p._id) } },
      ],
    })
      .populate("client", "name")
      .populate("property", "name")
      .select("client property status")
      .limit(limit)
      .lean();
    return rows.map((r) => ({
      id: r._id,
      name: `${r.client?.name || "Client"} — ${r.property?.name || "Property"}`,
      extra: r.status || "",
      type: "OPPORTUNITY",
    }));
  }
  return [];
}

module.exports = {
  enrichTodo,
  createTodo,
  listTodos,
  getTodoById,
  updateTodo,
  reassignTodo,
  startTodo,
  completeTodo,
  reopenTodo,
  cancelTodo,
  addComment,
  addAttachment,
  getSummary,
  getCalendarEvents,
  getDashboard,
  getPerformance,
  getFilterOptions,
  searchCrmEntities,
};
