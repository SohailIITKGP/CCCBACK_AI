const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const createNotification = require("../utils/notification");
const User = require("../models/User");
const { sendMailSafe, getEmailFrom } = require("../utils/smtpTransporter");
const {
  buildReminderStateForStatus,
  fireImmediateLeadReminderIfDue,
  isLeadReminderTrackedStatus,
} = require("../services/leadReminderService");
const { regenerateLeadReminderScheduleTasks } = require("../services/followUpTaskService");
const { logFieldChange, logDataAction } = require("../utils/auditLogger");
const leadFacade = require("../facades/leadFacade");
const {
  findDuplicateCandidates,
  mergeLeads: mergeDuplicateLeads,
} = require("../services/leadDuplicateService");
const {
  sanitizeClusters,
  sanitizeFormat,
  sanitizeKindOfBusiness,
} = require("../constants/businessClassification");

const SELECT_FIELDS =
  "name contactNumber email sourceOfConnection priority contactPerson state designation status assignedTo createdBy createdAt whenassign remarks updatedAt isConverted date correlationId lifecycleState kindOfBusiness format clusters";

const ALLOWED_LEAD_WRITE_FIELDS = [
  "name",
  "contactNumber",
  "contactPerson",
  "email",
  "state",
  "designation",
  "sourceOfConnection",
  "priority",
  "remarks",
  "status",
  "kindOfBusiness",
  "format",
  "clusters",
];

const ALLOWED_SORT_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "name",
  "priority",
  "status",
  "state",
  "sourceOfConnection",
  "contactPerson",
  "contactNumber",
  "email",
  "designation",
  "remarks",
  "date",
  "whenassign",
  "kindOfBusiness",
  "format",
]);

const LEAD_PRIORITY_ENUM = new Set(["Hot", "High", "Medium", "Cold", "Low"]);

function pickLeadWriteFields(body = {}) {
  const picked = {};
  for (const key of ALLOWED_LEAD_WRITE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      picked[key] = body[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(picked, "kindOfBusiness")) {
    picked.kindOfBusiness = sanitizeKindOfBusiness(picked.kindOfBusiness) || null;
  }
  if (Object.prototype.hasOwnProperty.call(picked, "format")) {
    picked.format = sanitizeFormat(picked.format) || null;
  }
  if (Object.prototype.hasOwnProperty.call(picked, "clusters")) {
    picked.clusters = sanitizeClusters(picked.clusters);
  }
  return picked;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Express can expose duplicate query keys as arrays */
function queryStr(v) {
  if (v === undefined || v === null) return "";
  const raw = Array.isArray(v) ? v[v.length - 1] : v;
  return String(raw).trim();
}

function anchoredCaseInsensitive(value) {
  return new RegExp(`^${escapeRegex(value)}$`, "i");
}

function parsePositiveInt(v, fallback, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function parseObjectId(id) {
  if (!id || typeof id !== "string") return null;
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

function formatLeadRow(lead) {
  return {
    _id: lead._id,
    name: lead.name,
    contactNumber: lead.contactNumber,
    email: lead.email,
    sourceOfConnection: lead.sourceOfConnection,
    priority: lead.priority,
    contactPerson: lead.contactPerson,
    state: lead.state,
    designation: lead.designation,
    status: lead.status,
    kindOfBusiness: lead.kindOfBusiness || "",
    format: lead.format || "",
    clusters: Array.isArray(lead.clusters) ? lead.clusters : [],
    assignedTo: lead.assignedTo
      ? { _id: lead.assignedTo._id, name: lead.assignedTo.name }
      : null,
    createdBy: lead.createdBy
      ? { _id: lead.createdBy._id, name: lead.createdBy.name }
      : null,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
    whenassign: lead.whenassign,
    remarks: lead.remarks,
    isConverted: lead.isConverted,
    correlationId: lead.correlationId,
    lifecycleState: lead.lifecycleState,
    date: lead.date,
  };
}

/**
 * Build role-scoped + optional filter match. Uses $and so Lead-Employee scope combines safely with search.
 */
async function buildLeadsListMatch(req, isConverted) {
  const userRole = req.user.role;
  const userId = req.user._id;

  const clauses = [{ isConverted: Boolean(isConverted) }];

  if (userRole === "Lead-Employee") {
    clauses.push({
      $or: [{ assignedTo: userId }, { createdBy: userId }],
    });
  } else if (
    !["Super Admin", "Manager", "BO-Client", "Product-Manager"].includes(
      userRole
    )
  ) {
    return { denied: true };
  }

  const {
    q,
    filterType,
    filterValue,
    dateFilterType,
    dateValue,
    startDate,
    endDate,
  } = req.query;

  const trimmedQ = queryStr(q);
  if (trimmedQ) {
    const rx = new RegExp(escapeRegex(trimmedQ), "i");
    const assignedUserIds = await User.find({ name: rx })
      .select("_id")
      .limit(200)
      .lean()
      .then((users) => users.map((u) => u._id));

    const searchOr = [
      { name: rx },
      { contactNumber: rx },
      { email: rx },
      { sourceOfConnection: rx },
      { priority: rx },
      { contactPerson: rx },
      { state: rx },
      { designation: rx },
      { status: rx },
      { remarks: rx },
    ];
    if (assignedUserIds.length) {
      searchOr.push({ assignedTo: { $in: assignedUserIds } });
    }
    clauses.push({ $or: searchOr });
  }

  const ft = queryStr(filterType);
  const fv = queryStr(filterValue);
  const dft = queryStr(dateFilterType);
  const dv = queryStr(dateValue);
  const sd = queryStr(startDate);
  const ed = queryStr(endDate);

  if (ft && fv) {
    switch (ft) {
      case "priority": {
        const matchEnum = [...LEAD_PRIORITY_ENUM].find(
          (p) => p.toLowerCase() === fv.toLowerCase()
        );
        if (matchEnum) clauses.push({ priority: matchEnum });
        break;
      }
      case "status":
        clauses.push({ status: anchoredCaseInsensitive(fv) });
        break;
      case "sourceOfConnection":
        clauses.push({
          sourceOfConnection: anchoredCaseInsensitive(fv),
        });
        break;
      case "state":
        clauses.push({ state: anchoredCaseInsensitive(fv) });
        break;
      case "assignedTo": {
        const oid = parseObjectId(fv);
        if (oid) clauses.push({ assignedTo: oid });
        break;
      }
      case "whoCreated": {
        const oid = parseObjectId(fv);
        if (oid) clauses.push({ createdBy: oid });
        break;
      }
      case "name":
        clauses.push({ name: new RegExp(escapeRegex(fv), "i") });
        break;
      case "contactNumber":
        clauses.push({
          contactNumber: new RegExp(escapeRegex(fv), "i"),
        });
        break;
      case "email":
        clauses.push({ email: new RegExp(escapeRegex(fv), "i") });
        break;
      case "contactPerson":
        clauses.push({
          contactPerson: new RegExp(escapeRegex(fv), "i"),
        });
        break;
      case "designation":
        clauses.push({
          designation: anchoredCaseInsensitive(fv),
        });
        break;
      default:
        break;
    }
  }

  if (ft === "date" && dft) {
    try {
      if (dft === "exact" && dv) {
        clauses.push({
          createdAt: {
            $gte: new Date(`${dv}T00:00:00.000Z`),
            $lte: new Date(`${dv}T23:59:59.999Z`),
          },
        });
      } else if (dft === "before" && dv) {
        clauses.push({
          createdAt: { $lt: new Date(`${dv}T00:00:00.000Z`) },
        });
      } else if (dft === "after" && dv) {
        clauses.push({
          createdAt: { $gt: new Date(`${dv}T23:59:59.999Z`) },
        });
      } else if (dft === "between" && sd && ed) {
        clauses.push({
          createdAt: {
            $gte: new Date(`${sd}T00:00:00.000Z`),
            $lte: new Date(`${ed}T23:59:59.999Z`),
          },
        });
      }
    } catch (_) {
      /* ignore invalid dates */
    }
  }

  if (clauses.length === 1) return { match: clauses[0] };
  return { match: { $and: clauses } };
}

async function queryLeadsPaginated(req, isConverted) {
  const built = await buildLeadsListMatch(req, isConverted);
  if (built.denied) return { denied: true };

  const page = parsePositiveInt(req.query.page, 1, 100000);
  const limit = parsePositiveInt(req.query.limit, 25, 100);
  const skip = (page - 1) * limit;

  const sortField = ALLOWED_SORT_FIELDS.has(req.query.sortBy)
    ? req.query.sortBy
    : "createdAt";
  const sortDir = req.query.sortOrder === "asc" ? 1 : -1;
  const sort = { [sortField]: sortDir };

  const [raw, total] = await Promise.all([
    Lead.find(built.match)
      .select(SELECT_FIELDS)
      .populate("assignedTo", "name email")
      .populate("createdBy", "name")
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    Lead.countDocuments(built.match),
  ]);

  const data = raw.map(formatLeadRow);
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return {
    denied: false,
    data,
    page,
    limit,
    total,
    totalPages,
    hasMore: page < totalPages,
  };
}

exports.createLead = async (req, res) => {
  const id = req.user._id;

  try {
    const leadData = {
      ...pickLeadWriteFields(req.body),
      createdBy: id,
    };

    const lead = await leadFacade.createLead(
      leadData,
      { type: "user", userId: id },
      { ipAddress: req.ip }
    );

    createNotification("Lead", "Created", lead._id, lead.name, id);

    logDataAction(req, {
      action: "data_create",
      resource: "Lead",
      resourceId: lead._id,
      entityName: lead.name,
      details: { status: lead.status || "" },
    }).catch(() => {});

    res.status(201).json({
      success: true, 
      data: lead 
    });
  } catch (error) {
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        messages,
      });
    }

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

exports.getAllLeads = async (req, res) => {
  try {
    const result = await queryLeadsPaginated(req, false);
    if (result.denied) {
      return res.status(403).json({ success: false, message: "Access Denied" });
    }
    res.status(200).json({
      success: true,
      data: result.data,
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
      message: `Loaded ${result.data.length} leads (page ${result.page} of ${result.totalPages})`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getAllLeadsClosed = async (req, res) => {
  try {
    const result = await queryLeadsPaginated(req, true);
    if (result.denied) {
      return res.status(403).json({ success: false, message: "Access Denied" });
    }
    res.status(200).json({
      success: true,
      data: result.data,
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getLeadById = async (req, res) => {
  try {
    const id = req.params.id;
    if (!parseObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid lead id" });
    }

    const lead = await Lead.findById(id)
      .select(SELECT_FIELDS)
      .populate("assignedTo", "name")
      .populate("createdBy", "name")
      .lean();

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    res.status(200).json({ success: true, data: formatLeadRow(lead) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.convertToClient = async (req, res) => {
  const id = req.user._id;

  try {
    const allowedRoles = [
      "Super Admin",
      "Manager",
      "BO-Client",
      "FE-Property",
      "Lead-Employee",
      "Product-Manager",
    ];
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Access denied." });
    }

    if (!req.body.assignedTo) {
      return res.status(400).json({
        success: false,
        message: "Employee assignment is required. Please assign a client to an employee.",
      });
    }

    const result = await leadFacade.convertLeadToClient(
      req.params.id,
      {
        priority: req.body.priority || "High",
        assignedTo: req.body.assignedTo,
        clientFields: req.body.clientFields || {},
      },
      { type: "user", userId: id },
      { ipAddress: req.ip }
    );

    if (result.error === "not_found") {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }
    if (result.error === "already_converted") {
      return res.status(400).json({ success: false, message: "Lead already converted" });
    }
    if (result.error === "invalid_employee") {
      return res.status(400).json({
        success: false,
        message: "Invalid employee ID. Please select a valid employee.",
      });
    }

    const { client, lead } = result;
    const employee = await User.findById(req.body.assignedTo).select("name email").lean();

    logDataAction(req, {
      action: "admin_action",
      resource: "Lead",
      resourceId: lead._id,
      entityName: lead.name,
      details: {
        action: "convert_to_client",
        clientId: String(client._id),
        clientName: client.name,
        assignedTo: employee?.name || employee?.email || req.body.assignedTo,
        priority: client.priority || "",
        requirements: result.clientFields || {},
      },
    }).catch(() => {});

    logDataAction(req, {
      action: "data_create",
      resource: "Client",
      resourceId: client._id,
      entityName: client.name,
      details: {
        action: "from_lead_conversion",
        leadId: String(lead._id),
        leadName: lead.name,
        assignedTo: employee?.name || employee?.email || req.body.assignedTo,
      },
    }).catch(() => {});

    return res.status(201).json({ success: true, data: client });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateLead = async (req, res) => {
  try {
    const existing = await Lead.findById(req.params.id).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    const updates = pickLeadWriteFields(req.body);
    const lead = await leadFacade.updateLead(
      req.params.id,
      updates,
      { type: "user", userId: req.user._id },
      { ipAddress: req.ip }
    );

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    await createNotification("Lead", "Updated", lead._id, lead.name);

    if (updates.status !== undefined && updates.status !== existing.status) {
      logFieldChange(req, {
        resource: "Lead",
        resourceId: lead._id,
        entityName: lead.name,
        field: "status",
        from: existing.status,
        to: lead.status,
      }).catch(() => {});
    }

    const populated = await Lead.findById(lead._id)
      .select(SELECT_FIELDS)
      .populate("assignedTo", "name")
      .populate("createdBy", "name")
      .lean();

    res.status(200).json({ success: true, data: formatLeadRow(populated) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.deleteLead = async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });

    await createNotification("Lead", "Deleted", lead._id, lead.name);

    logDataAction(req, {
      action: "data_delete",
      resource: "Lead",
      resourceId: lead._id,
      entityName: lead.name,
    }).catch(() => {});

    res
      .status(200)
      .json({ success: true, message: "Lead successfully deleted" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getleademployeee = async (req, res) => {
  try {
    const userRole = req.user.role;
    // console.log(userRole);
    const userId = req.user._id;

    let Users;

    if (userRole === "Super Admin" || userRole === "Manager" || userRole === "Product-Manager") {
      Users = await User.find({ role: { $in: ["Lead-Employee", "BO-Client", "Manager" , "Super Admin"] } }).select(
        "name email phone role id"
      );
    } else if (userRole === "BO-Client") {
      Users = await User.find({ role: { $in: ["Lead-Employee", "Manager" , "BO-Client"] } }).select(
        "name email phone role id"
      );
    } else {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    res.status(200).json({ success: true, data: Users });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
    console.log(error);
  }
};

exports.asignleademployee = async (req, res) => {
  const { leadId } = req.params;
  const { leadEmployeeId } = req.body;
  const assignerId = req.user?._id;
  const userid = assignerId || req.body.userid;

  if (!leadEmployeeId) {
    return res
      .status(400)
      .json({ success: false, message: "Lead Employee ID is required" });
  }

  try {
    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }

    const previousAssignee = lead.assignedTo?.toString() || null;

    lead.assignedTo = leadEmployeeId;
    lead.whoassign = userid;
    lead.whenassign = Date.now();

    await User.findByIdAndUpdate(leadEmployeeId, {
      $push: { leadassign: leadId },
    }); // Corrected

    await lead.save();

    const employee = await User.findById(leadEmployeeId);

    // Get the assigner details
    const assigner = await User.findById(userid);

    const previousEmployee = previousAssignee
      ? await User.findById(previousAssignee).select("name email").lean()
      : null;

    logFieldChange(req, {
      resource: "Lead",
      resourceId: lead._id,
      entityName: lead.name,
      field: "assignedTo",
      from: previousEmployee?.name || previousEmployee?.email || "Unassigned",
      to: employee?.name || employee?.email || leadEmployeeId,
      extra: {
        assigneeId: leadEmployeeId,
        previousAssigneeId: previousAssignee,
      },
    }).catch(() => {});

    await sendMailSafe({
      from: getEmailFrom(),
      to: employee.email,
      subject: "New Lead Assignment Notification",
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
          <h2>New Lead Assignment</h2>
          <p>Dear ${employee.name},</p>
          <p>A new lead has been assigned to you by ${assigner ? assigner.name : 'Admin'} (${assigner ? assigner.role : 'Admin'}).</p>
          <p>Lead Name: ${lead.name}</p>
          <p>Lead Contact: ${lead.phone}</p>
          <p>Please log in to the system to view complete lead details and take appropriate action.</p>
          <p>Thank you,<br>Rewa Realtors Team</p>
        </div>
      `,
    });

    res
      .status(200)
      .json({
        success: true,
        message: "Lead assigned successfully and notification sent",
        data: lead,
      });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateStatus = async (req, res) => {
  const allowedRoles = [
    "Super Admin",
    "Manager",
    "BO-Client",
    "FE-Property",
    "Lead-Employee",
    "Product-Manager",
  ];

  try {
    if (!allowedRoles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ success: false, message: "Access denied." });
    }

    const { id } = req.params;

    const lead = await Lead.findById(id);
    if (!lead) {
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    }

    const previousStatus = lead.status;

    Object.assign(lead, req.body);

    const statusChanged =
      req.body.status !== undefined && req.body.status !== previousStatus;

    if (statusChanged) {
      lead.reminderState = buildReminderStateForStatus(req.body.status, new Date());
    }

    await lead.save();

    if (statusChanged) {
      regenerateLeadReminderScheduleTasks(lead).catch((err) =>
        console.error("[leadController] reminder task sync failed:", err.message)
      );
      if (isLeadReminderTrackedStatus(lead.status)) {
        fireImmediateLeadReminderIfDue(lead._id).catch((err) =>
          console.error("[leadController] immediate lead reminder failed:", err.message)
        );
      }
    }

    if (statusChanged) {
      logFieldChange(req, {
        resource: "Lead",
        resourceId: lead._id,
        entityName: lead.name,
        field: "status",
        from: previousStatus,
        to: lead.status,
      }).catch(() => {});
    }

    await createNotification("Lead", "Status Updated", lead._id, lead.name);
    res.status(200).json({
      success: true,
      message: "Status updated successfully",
      data: lead,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getLeadDuplicates = async (req, res) => {
  try {
    const id = req.params.id;
    if (!parseObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid lead id" });
    }

    const lead = await Lead.findById(id).select("name email contactNumber").lean();
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    const duplicates = await findDuplicateCandidates(lead);
    return res.status(200).json({ success: true, duplicates });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

exports.mergeLeads = async (req, res) => {
  try {
    const { primaryLeadId, duplicateLeadId, reason } = req.body || {};
    if (!parseObjectId(primaryLeadId) || !parseObjectId(duplicateLeadId)) {
      return res.status(400).json({
        success: false,
        message: "primaryLeadId and duplicateLeadId are required",
      });
    }

    const result = await mergeDuplicateLeads({
      primaryLeadId,
      duplicateLeadId,
      userId: req.user._id,
      reason: reason || "same_person",
    });

    if (result.error) {
      const status =
        result.error === "not_found"
          ? 404
          : 400;
      return res.status(status).json({ success: false, message: result.message });
    }

    logDataAction(req, {
      action: "lead_merged",
      resource: "Lead",
      resourceId: result.primary._id,
      entityName: result.primary.name,
      details: {
        duplicateLeadId: result.duplicate._id.toString(),
        duplicateName: result.duplicate.name,
        reason: reason || "same_person",
      },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: "Duplicate lead merged successfully",
      data: {
        primary: formatLeadRow(result.primary),
        duplicate: formatLeadRow(result.duplicate),
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
