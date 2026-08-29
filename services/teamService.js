const mongoose = require("mongoose");
const Team = require("../models/Team");
const User = require("../models/User");
const { canManageTeams, isManager, uniqueIds, toId } = require("../utils/todoAccess");

function sanitizeName(value) {
  return String(value || "").trim().slice(0, 120);
}

async function assertActiveUsers(ids) {
  if (!ids.length) return [];
  const users = await User.find({
    _id: { $in: ids },
    status: "Active",
  })
    .select("_id")
    .lean();
  if (users.length !== ids.length) {
    const err = new Error("One or more members are invalid or inactive");
    err.status = 400;
    throw err;
  }
  return ids;
}

async function listTeams(user) {
  const filter = isManager(user)
    ? { status: "Active" }
    : {
        status: "Active",
        $or: [{ coordinator: user._id }, { members: user._id }, { createdBy: user._id }],
      };
  return Team.find(filter)
    .populate("coordinator", "name email role")
    .populate("members", "name email role")
    .sort({ name: 1 })
    .lean();
}

async function createTeam(user, body) {
  if (!canManageTeams(user)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const name = sanitizeName(body.name);
  if (!name) {
    const err = new Error("Team name is required");
    err.status = 400;
    throw err;
  }
  const members = await assertActiveUsers(uniqueIds(body.members));
  const coordinator =
    body.coordinator && mongoose.isValidObjectId(body.coordinator)
      ? String(body.coordinator)
      : toId(user._id);
  if (!members.includes(coordinator)) members.push(coordinator);

  try {
    const team = await Team.create({
      name,
      description: String(body.description || "").trim().slice(0, 2000),
      coordinator,
      members,
      createdBy: user._id,
      status: "Active",
    });
    return Team.findById(team._id)
      .populate("coordinator", "name email role")
      .populate("members", "name email role");
  } catch (error) {
    if (error.code === 11000) {
      const err = new Error("A team with this name already exists");
      err.status = 409;
      throw err;
    }
    throw error;
  }
}

async function updateTeam(user, id, body) {
  if (!canManageTeams(user)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  if (!mongoose.isValidObjectId(id)) {
    const err = new Error("Invalid team id");
    err.status = 400;
    throw err;
  }
  const team = await Team.findById(id);
  if (!team) {
    const err = new Error("Team not found");
    err.status = 404;
    throw err;
  }
  if (body.name != null) {
    const name = sanitizeName(body.name);
    if (!name) {
      const err = new Error("Team name is required");
      err.status = 400;
      throw err;
    }
    team.name = name;
  }
  if (body.description != null) {
    team.description = String(body.description || "").trim().slice(0, 2000);
  }
  if (body.members) {
    team.members = await assertActiveUsers(uniqueIds(body.members));
  }
  if (body.coordinator) {
    if (!mongoose.isValidObjectId(body.coordinator)) {
      const err = new Error("Invalid coordinator");
      err.status = 400;
      throw err;
    }
    team.coordinator = body.coordinator;
    const memberIds = uniqueIds(team.members);
    if (!memberIds.includes(String(body.coordinator))) {
      team.members.push(body.coordinator);
    }
  }
  if (body.status === "Active" || body.status === "Inactive") {
    team.status = body.status;
  }
  try {
    await team.save();
  } catch (error) {
    if (error.code === 11000) {
      const err = new Error("A team with this name already exists");
      err.status = 409;
      throw err;
    }
    throw error;
  }
  return Team.findById(team._id)
    .populate("coordinator", "name email role")
    .populate("members", "name email role");
}

module.exports = {
  listTeams,
  createTeam,
  updateTeam,
};
