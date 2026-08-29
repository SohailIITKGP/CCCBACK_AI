const mongoose = require("mongoose");
const Client = require("../models/Client");
const User = require("../models/User");

const CLIENT_SELECT_FULL =
  "name contactPerson remarks state designation email contactDetails kindOfBusiness format clusters requirement minimumArea city preferredArea expectedRent priority assignedTo linkedProperties whoConverted feFoundProperties createdAt updatedAt isVisibility";

const CLIENT_SELECT_PM =
  "remarks state kindOfBusiness format clusters requirement minimumArea city preferredArea expectedRent priority assignedTo linkedProperties whoConverted feFoundProperties createdAt updatedAt isVisibility designation";

const CLIENT_SELECT_FE =
  "remarks state designation kindOfBusiness format clusters requirement minimumArea city preferredArea expectedRent priority assignedTo linkedProperties whoConverted feFoundProperties createdAt updatedAt isVisibility";

const CLIENT_SELECT = CLIENT_SELECT_FULL;

function clientSelectForRole(userRole) {
  if (userRole === "Product-Manager") return CLIENT_SELECT_PM;
  if (userRole === "FE-Property") return CLIENT_SELECT_FE;
  return CLIENT_SELECT_FULL;
}

const ALLOWED_SORT_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "name",
  "priority",
  "city",
  "state",
  "expectedRent",
  "designation",
  "kindOfBusiness",
  "format",
  "contactPerson",
  "email",
  "minimumArea",
  "remarks",
  "requirement",
  "preferredArea",
  "assignedTo",
  "whoConverted",
]);

const ALLOWED_FILTER_FIELDS = new Set([
  "name",
  "email",
  "contactPerson",
  "designation",
  "kindOfBusiness",
  "format",
  "priority",
  "city",
  "assignedTo",
  "preferredArea",
  "expectedRent",
  "minimumArea",
  "whoConverted",
  "remarks",
  "createdAt",
  "contactDetails",
  "requirement",
  "isPropertyLinked",
  "state",
]);

/** Must match `cccback/models/Client.js` → `priority.enum` exactly (canonical casing). */
const CLIENT_PRIORITY_ENUM = Object.freeze([
  "Hot",
  "High",
  "Medium",
  "Cold",
  "Low",
]);

/** Advanced filter `isPropertyLinked` value options (UI sends these exact strings). */
const IS_PROPERTY_LINKED_FILTER_VALUES = new Set(["Yes", "No"]);

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function queryStr(v) {
  if (v === undefined || v === null) return "";
  const raw = Array.isArray(v) ? v[v.length - 1] : v;
  return String(raw).trim();
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

function parseFiltersList(req) {
  try {
    const raw = req.query.filters;
    const s =
      typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";
    if (!s || !s.trim()) return [];
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.slice(0, 25) : [];
  } catch {
    return [];
  }
}

function stringFieldClause(field, operator, value, value2) {
  const esc = escapeRegex(String(value));
  switch (operator) {
    case "equals":
      return { [field]: new RegExp(`^${esc}$`, "i") };
    case "contains":
      return { [field]: new RegExp(esc, "i") };
    case "startsWith":
      return { [field]: new RegExp(`^${esc}`, "i") };
    case "endsWith":
      return { [field]: new RegExp(`${esc}$`, "i") };
    case "between": {
      if (!value2) return null;
      const esc2 = escapeRegex(String(value2));
      return {
        [field]: {
          $gte: String(value),
          $lte: String(value2),
        },
      };
    }
    default:
      return null;
  }
}

function numericBetweenExpr(fieldPath, lo, hi) {
  return {
    $expr: {
      $and: [
        {
          $gte: [
            {
              $convert: {
                input: fieldPath,
                to: "double",
                onError: null,
                onNull: null,
              },
            },
            lo,
          ],
        },
        {
          $lte: [
            {
              $convert: {
                input: fieldPath,
                to: "double",
                onError: null,
                onNull: null,
              },
            },
            hi,
          ],
        },
      ],
    },
  };
}

function numericCompareExpr(fieldPath, op, n) {
  const conv = {
    $convert: {
      input: fieldPath,
      to: "double",
      onError: null,
      onNull: null,
    },
  };
  if (op === "greaterThan") return { $expr: { $gt: [conv, n] } };
  if (op === "lessThan") return { $expr: { $lt: [conv, n] } };
  if (op === "equals")
    return { $expr: { $eq: [conv, n] } };
  return null;
}

async function buildOneFilterCondition(cond) {
  if (!cond || typeof cond !== "object") return null;
  const field = queryStr(cond.field);
  const operator = queryStr(cond.operator) || "equals";
  const value =
    cond.value !== undefined && cond.value !== null
      ? String(cond.value).trim()
      : "";
  const value2 =
    cond.value2 !== undefined && cond.value2 !== null
      ? String(cond.value2).trim()
      : "";

  if (!field || !ALLOWED_FILTER_FIELDS.has(field)) return null;
  if (operator === "between" && (!value || !value2)) return null;
  if (operator !== "between" && !value) return null;

  if (field === "assignedTo" || field === "whoConverted") {
    if (operator === "equals") {
      const oid = parseObjectId(value);
      return oid ? { [field]: oid } : null;
    }
    if (["contains", "startsWith", "endsWith"].includes(operator)) {
      const pattern =
        operator === "contains"
          ? escapeRegex(value)
          : operator === "startsWith"
            ? `^${escapeRegex(value)}`
            : `${escapeRegex(value)}$`;
      const rx = new RegExp(pattern, "i");
      const ids = await User.find({ name: rx })
        .select("_id")
        .limit(200)
        .lean()
        .then((rows) => rows.map((r) => r._id));
      if (!ids.length) return { [field]: { $in: [] } };
      return { [field]: { $in: ids } };
    }
    return null;
  }

  if (field === "isPropertyLinked") {
    if (operator !== "equals") return null;
    if (!IS_PROPERTY_LINKED_FILTER_VALUES.has(value)) return null;
    if (value === "Yes") return { "linkedProperties.0": { $exists: true } };
    return { "linkedProperties.0": { $exists: false } };
  }

  if (field === "priority") {
    if (operator !== "equals") return null;
    const matchEnum = CLIENT_PRIORITY_ENUM.find(
      (p) => p.toLowerCase() === value.toLowerCase()
    );
    return matchEnum ? { priority: matchEnum } : null;
  }

  if (field === "createdAt") {
    const parseDay = (s) => {
      if (!s) return null;
      const d = new Date(s.length <= 10 ? `${s}T00:00:00.000Z` : s);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const d1 = parseDay(value);
    const d2 = parseDay(value2);
    if (operator === "equals" && d1) {
      const end = new Date(`${value}T23:59:59.999Z`);
      return { createdAt: { $gte: d1, $lte: end } };
    }
    if (operator === "before" && d1) {
      return { createdAt: { $lt: d1 } };
    }
    if (operator === "after" && d1) {
      return { createdAt: { $gt: new Date(`${value}T23:59:59.999Z`) } };
    }
    if (operator === "between" && d1 && d2) {
      const end = new Date(`${value2}T23:59:59.999Z`);
      return { createdAt: { $gte: d1, $lte: end } };
    }
    return stringFieldClause("createdAt", operator, value, value2);
  }

  if (field === "minimumArea") {
    const n = parseFloat(String(value).replace(/,/g, ""));
    const n2 = parseFloat(String(value2).replace(/,/g, ""));
    if (operator === "between" && Number.isFinite(n) && Number.isFinite(n2)) {
      const lo = Math.min(n, n2);
      const hi = Math.max(n, n2);
      return numericBetweenExpr("$minimumArea", lo, hi);
    }
    if (
      ["greaterThan", "lessThan", "equals"].includes(operator) &&
      Number.isFinite(n)
    ) {
      return numericCompareExpr("$minimumArea", operator, n);
    }
    return stringFieldClause(field, operator, value, value2);
  }

  if (field === "expectedRent") {
    const n = parseFloat(String(value).replace(/,/g, ""));
    const n2 = parseFloat(String(value2).replace(/,/g, ""));
    if (operator === "between" && Number.isFinite(n) && Number.isFinite(n2)) {
      const lo = Math.min(n, n2);
      const hi = Math.max(n, n2);
      return numericBetweenExpr("$expectedRent", lo, hi);
    }
    if (
      ["greaterThan", "lessThan", "equals"].includes(operator) &&
      Number.isFinite(n)
    ) {
      return numericCompareExpr("$expectedRent", operator, n);
    }
    return stringFieldClause(field, operator, value, value2);
  }

  return stringFieldClause(field, operator, value, value2);
}

async function buildClientListMatch(req) {
  const userRole = req.user.role;
  const userId = req.user._id;

  const clauses = [{ isVisibility: true }];

  if (["Super Admin", "Manager", "BO-Client"].includes(userRole)) {
    /* no extra scope */
  } else if (userRole === "Lead-Employee") {
    clauses.push({ whoConverted: userId });
  } else if (userRole === "FE-Property") {
    clauses.push({ assignedTo: userId });
  } else if (userRole === "Product-Manager") {
    /* all visible clients */
  } else {
    return { denied: true };
  }

  const trimmedQ = queryStr(req.query.q);
  if (trimmedQ) {
    const rx = new RegExp(escapeRegex(trimmedQ), "i");
    const userIds = await User.find({ name: rx })
      .select("_id")
      .limit(200)
      .lean()
      .then((rows) => rows.map((r) => r._id));
    const or = [
      { name: rx },
      { contactPerson: rx },
      { email: rx },
      { contactDetails: rx },
      { kindOfBusiness: rx },
      { requirement: rx },
      { minimumArea: rx },
      { city: rx },
      { state: rx },
      { designation: rx },
      { preferredArea: rx },
      { expectedRent: rx },
      { priority: rx },
      { remarks: rx },
    ];
    if (userIds.length) {
      or.push({ assignedTo: { $in: userIds } });
      or.push({ whoConverted: { $in: userIds } });
    }
    clauses.push({ $or: or });
  }

  const filterList = parseFiltersList(req);
  for (const cond of filterList) {
    if (!cond || !cond.field) continue;
    const piece = await buildOneFilterCondition(cond);
    if (piece) clauses.push(piece);
  }

  if (clauses.length === 1)
    return {
      denied: false,
      match: clauses[0],
      select: clientSelectForRole(userRole),
    };
  return {
    denied: false,
    match: { $and: clauses },
    select: clientSelectForRole(userRole),
  };
}

async function queryClientsPaginated(req, formatRow) {
  const built = await buildClientListMatch(req);
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
    Client.find(built.match)
      .select(built.select)
      .populate("assignedTo", "name email role")
      .populate("linkedProperties", "name city area expectedRent")
      .populate("whoConverted", "name role")
      .populate({
        path: "feFoundProperties.property",
        select: "name city area expectedRent address",
      })
      .populate({ path: "feFoundProperties.punchedBy", select: "name role" })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    Client.countDocuments(built.match),
  ]);

  const data = raw.map(formatRow);
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

module.exports = {
  queryClientsPaginated,
};
