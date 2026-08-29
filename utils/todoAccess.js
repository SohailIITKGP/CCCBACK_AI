const mongoose = require("mongoose");
const Team = require("../models/Team");

const TODO_ROLES = [
  "Super Admin",
  "Manager",
  "BO-Client",
  "Lead-Employee",
  "Product-Manager",
  "BO-Lead",
  "FE-Property",
];

const ADMIN_ROLES = ["Super Admin", "Manager"];
const ASSIGNER_ROLES = ["Super Admin", "Manager", "Product-Manager"];

const isAdmin = (user) => user && user.role === "Super Admin";
const isManager = (user) => user && ADMIN_ROLES.includes(user.role);
const isGlobalAssigner = (user) => user && ASSIGNER_ROLES.includes(user.role);

const toId = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value._id) return String(value._id);
  return String(value);
};

const uniqueIds = (values) => {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const id = toId(value);
    if (!id || !mongoose.isValidObjectId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

async function loadTeamContext(userId) {
  const uid = toId(userId);
  const [coordinated, memberOf] = await Promise.all([
    Team.find({ coordinator: uid, status: "Active" }).select("_id members coordinator").lean(),
    Team.find({ members: uid, status: "Active" }).select("_id members coordinator").lean(),
  ]);
  return {
    coordinatedTeamIds: coordinated.map((t) => String(t._id)),
    memberTeamIds: memberOf.map((t) => String(t._id)),
    coordinatedTeams: coordinated,
    memberTeams: memberOf,
  };
}

function isParticipant(todo, userId) {
  const id = toId(userId);
  if (!id || !todo) return false;
  if (toId(todo.owner) === id) return true;
  if (toId(todo.createdBy) === id) return true;
  if (toId(todo.assignedBy) === id) return true;
  if ((todo.assignedTo || []).some((u) => toId(u) === id)) return true;
  if ((todo.collaborators || []).some((u) => toId(u) === id)) return true;
  return false;
}

function isAssignee(todo, userId) {
  const id = toId(userId);
  return (todo.assignedTo || []).some((u) => toId(u) === id);
}

function canViewTodo(user, todo, teamCtx = {}) {
  if (!user || !todo) return false;
  if (isManager(user)) return true;
  if (isParticipant(todo, user._id)) return true;
  const teamId = toId(todo.team);
  if (teamId && (teamCtx.coordinatedTeamIds || []).includes(teamId)) return true;
  return false;
}

function canEditTodo(user, todo, teamCtx = {}) {
  if (!user || !todo) return false;
  if (isManager(user)) return true;
  if (toId(todo.owner) === toId(user._id)) return true;
  if (toId(todo.assignedBy) === toId(user._id)) return true;
  if (isGlobalAssigner(user) && isParticipant(todo, user._id)) return true;
  const teamId = toId(todo.team);
  if (teamId && (teamCtx.coordinatedTeamIds || []).includes(teamId)) return true;
  return false;
}

function canChangeStatus(user, todo, teamCtx = {}) {
  if (canEditTodo(user, todo, teamCtx)) return true;
  return isAssignee(todo, user._id);
}

function canComment(user, todo, teamCtx = {}) {
  return canViewTodo(user, todo, teamCtx);
}

function canManageTeams(user) {
  return isGlobalAssigner(user);
}

/**
 * Employees may only assign to themselves.
 * Managers / Product-Managers may assign to anyone.
 * Team coordinators may assign to members of teams they coordinate.
 */
async function assertCanAssign({ user, assignedToIds, teamId, teamCtx }) {
  const targets = uniqueIds(assignedToIds);
  const selfId = toId(user._id);

  if (isGlobalAssigner(user)) return { ok: true, targets };

  if (teamId) {
    if (!mongoose.isValidObjectId(teamId)) {
      return { ok: false, status: 400, message: "Invalid team id" };
    }
    const coordinated = (teamCtx?.coordinatedTeamIds || []).includes(String(teamId));
    if (!coordinated) {
      return { ok: false, status: 403, message: "You can only assign work to teams you coordinate" };
    }
    const team =
      (teamCtx?.coordinatedTeams || []).find((t) => String(t._id) === String(teamId)) ||
      (await Team.findById(teamId).select("members coordinator").lean());
    if (!team) return { ok: false, status: 404, message: "Team not found" };
    const allowed = new Set([
      ...((team.members || []).map(toId)),
      toId(team.coordinator),
    ]);
    if (targets.some((id) => !allowed.has(id))) {
      return { ok: false, status: 403, message: "Assignees must belong to the selected team" };
    }
    return { ok: true, targets };
  }

  if (targets.length === 0 || (targets.length === 1 && targets[0] === selfId)) {
    return { ok: true, targets: targets.length ? targets : [selfId] };
  }

  return {
    ok: false,
    status: 403,
    message: "Employees can only create personal To-Dos assigned to themselves",
  };
}

function buildVisibilityFilter(user, teamCtx, { tab } = {}) {
  if (isManager(user) && tab === "all") {
    return {};
  }

  const uid = new mongoose.Types.ObjectId(user._id);
  const or = [
    { owner: uid },
    { createdBy: uid },
    { assignedBy: uid },
    { assignedTo: uid },
    { collaborators: uid },
  ];

  if ((teamCtx.coordinatedTeamIds || []).length) {
    or.push({
      team: {
        $in: teamCtx.coordinatedTeamIds.map((id) => new mongoose.Types.ObjectId(id)),
      },
    });
  }

  return { $or: or };
}

module.exports = {
  TODO_ROLES,
  ADMIN_ROLES,
  ASSIGNER_ROLES,
  isAdmin,
  isManager,
  isGlobalAssigner,
  toId,
  uniqueIds,
  loadTeamContext,
  isParticipant,
  isAssignee,
  canViewTodo,
  canEditTodo,
  canChangeStatus,
  canComment,
  canManageTeams,
  assertCanAssign,
  buildVisibilityFilter,
};
