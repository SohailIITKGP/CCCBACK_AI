const teamService = require("../services/teamService");
const { TODO_ROLES } = require("../utils/todoAccess");

const sendError = (res, error, fallback) => {
  const status = error.status || 500;
  if (status >= 500) console.error(fallback, error);
  return res.status(status).json({
    success: false,
    message: status >= 500 ? fallback : error.message,
  });
};

const gate = (req) => {
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
};

exports.list = async (req, res) => {
  try {
    gate(req);
    const teams = await teamService.listTeams(req.user);
    return res.status(200).json({ success: true, teams });
  } catch (error) {
    return sendError(res, error, "Failed to fetch teams");
  }
};

exports.create = async (req, res) => {
  try {
    gate(req);
    const team = await teamService.createTeam(req.user, req.body || {});
    return res.status(201).json({ success: true, team });
  } catch (error) {
    return sendError(res, error, "Failed to create team");
  }
};

exports.update = async (req, res) => {
  try {
    gate(req);
    const team = await teamService.updateTeam(req.user, req.params.id, req.body || {});
    return res.status(200).json({ success: true, team });
  } catch (error) {
    return sendError(res, error, "Failed to update team");
  }
};
