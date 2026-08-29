const mongoose = require("mongoose");
const Property = require("../models/propertyModel");
const User = require("../models/User");

/** Mirrors `getAllProperties` role-based selects (non-archive list). */
const PROPERTY_SELECT_FULL =
  "name owner pinPointLocation propertySourceName shopNo lumsumRent docklevelnoQty fireSafety washroomQty floorStrength roadName contact address city clusters format brandCategory floor height frontageRoad area exactArea expectedRent rentType possession category whoCreated whoLinkthis createdAt updatedAt propertyImages nearestBrandImage planLayoutImage insideViewImage brochurePdf propertyVideo linkedClients opportunities isVisibility isArchive";

const PROPERTY_SELECT_LEAD_BO =
  "name address pinPointLocation city area shopNo lumsumRent clusters format brandCategory docklevelnoQty fireSafety washroomQty floorStrength roadName height floor frontageRoad exactArea expectedRent rentType possession category whoCreated whoLinkthis createdAt updatedAt isVisibility isArchive propertyImages nearestBrandImage planLayoutImage insideViewImage brochurePdf propertyVideo linkedClients opportunities";

const PROPERTY_SELECT_PM =
  "name address owner pinPointLocation contact city propertySourceName area shopNo lumsumRent clusters format brandCategory docklevelnoQty fireSafety washroomQty floorStrength roadName height floor frontageRoad exactArea expectedRent rentType possession category propertyImages nearestBrandImage planLayoutImage insideViewImage brochurePdf propertyVideo linkedClients opportunities whoCreated whoLinkthis createdAt updatedAt isVisibility isArchive";

function propertySelectForRole(userRole) {
  if (userRole === "Product-Manager") return PROPERTY_SELECT_PM;
  if (userRole === "Lead-Employee" || userRole === "BO-Client") {
    return PROPERTY_SELECT_LEAD_BO;
  }
  return PROPERTY_SELECT_FULL;
}

const ALLOWED_SORT_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "name",
  "city",
  "category",
  "format",
  "brandCategory",
  "expectedRent",
  "rentType",
  "possession",
  "area",
  "exactArea",
  "height",
  "owner",
  "address",
  "roadName",
  "lumsumRent",
  "whoCreated",
  "whoLinkthis",
  "propertySourceName",
  "shopNo",
  "floor",
]);

const ALLOWED_FILTER_FIELDS = new Set([
  "name",
  "owner",
  "propertySourceName",
  "contact",
  "category",
  "format",
  "brandCategory",
  "shopNo",
  "address",
  "pinPointLocation",
  "city",
  "roadName",
  "floor",
  "area",
  "exactArea",
  "height",
  "frontageRoad",
  "docklevelnoQty",
  "fireSafety",
  "washroomQty",
  "floorStrength",
  "expectedRent",
  "lumsumRent",
  "rentType",
  "possession",
  "whoCreated",
  "createdAt",
  "isClientLinked",
]);

const IS_CLIENT_LINKED_FILTER_VALUES = new Set(["Yes", "No"]);
const FIRE_SAFETY_YES_NO = new Set(["Yes", "No"]);

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

function normalizeOperator(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const map = {
    equals: "equals",
    contains: "contains",
    "starts with": "startsWith",
    "ends with": "endsWith",
    "greater than": "greaterThan",
    "less than": "lessThan",
    between: "between",
    before: "before",
    after: "after",
  };
  if (map[s]) return map[s];
  if (
    [
      "equals",
      "contains",
      "startsWith",
      "endsWith",
      "greaterThan",
      "lessThan",
      "between",
      "before",
      "after",
    ].includes(s)
  ) {
    return s;
  }
  return "equals";
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
  if (op === "equals") return { $expr: { $eq: [conv, n] } };
  return null;
}

async function buildOneFilterCondition(cond) {
  if (!cond || typeof cond !== "object") return null;
  const field = queryStr(cond.field);
  let operator = normalizeOperator(cond.operator);
  const value =
    cond.value !== undefined && cond.value !== null
      ? String(cond.value).trim()
      : "";
  const value2 =
    cond.value2 !== undefined && cond.value2 !== null
      ? String(cond.value2).trim()
      : "";

  if (!field || !ALLOWED_FILTER_FIELDS.has(field)) return null;

  if (field === "createdAt") {
    if (operator === "greaterThan") operator = "after";
    if (operator === "lessThan") operator = "before";
  }

  if (field === "isClientLinked") {
    if (operator !== "equals") return null;
    if (!value || !IS_CLIENT_LINKED_FILTER_VALUES.has(value)) return null;
    if (value === "Yes") return { "linkedClients.0": { $exists: true } };
    return { "linkedClients.0": { $exists: false } };
  }

  if (operator === "between" && (!value || !value2)) return null;
  if (operator !== "between" && !value) return null;

  if (field === "whoCreated") {
    if (operator === "equals") {
      const oid = parseObjectId(value);
      if (oid) return { whoCreated: oid };
      const rx = new RegExp(`^${escapeRegex(value)}$`, "i");
      const ids = await User.find({ name: rx })
        .select("_id")
        .limit(200)
        .lean()
        .then((rows) => rows.map((r) => r._id));
      if (!ids.length) return { whoCreated: { $in: [] } };
      return { whoCreated: { $in: ids } };
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
      if (!ids.length) return { whoCreated: { $in: [] } };
      return { whoCreated: { $in: ids } };
    }
    return null;
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

  if (field === "fireSafety" && operator === "equals" && FIRE_SAFETY_YES_NO.has(value)) {
    return { fireSafety: new RegExp(`^${escapeRegex(value)}$`, "i") };
  }

  const numericStringFields = new Set([
    "expectedRent",
    "lumsumRent",
    "exactArea",
    "height",
  ]);
  if (numericStringFields.has(field)) {
    const n = parseFloat(String(value).replace(/,/g, ""));
    const n2 = parseFloat(String(value2).replace(/,/g, ""));
    if (operator === "between" && Number.isFinite(n) && Number.isFinite(n2)) {
      const lo = Math.min(n, n2);
      const hi = Math.max(n, n2);
      return numericBetweenExpr(`$${field}`, lo, hi);
    }
    if (
      ["greaterThan", "lessThan", "equals"].includes(operator) &&
      Number.isFinite(n)
    ) {
      return numericCompareExpr(`$${field}`, operator, n);
    }
  }

  return stringFieldClause(field, operator, value, value2);
}

async function buildPropertyListMatch(req, isArchive) {
  const userRole = req.user.role;
  const userId = req.user._id;

  const clauses = [{ isArchive: Boolean(isArchive) }];

  const listType = String(req.query.listType || "open").toLowerCase();
  if (listType === "closed") {
    clauses.push({
      $or: [{ isVisibility: false }, { propertyStatus: "closed" }],
    });
  } else if (listType === "pending") {
    clauses.push({ propertyStatus: "draft" });
  } else {
    clauses.push({ isVisibility: true }, { propertyStatus: "approved" });
  }

  if (userRole === "Manager" || userRole === "Super Admin") {
    /* full list */
  } else if (userRole === "FE-Property") {
    clauses.push({ whoCreated: userId });
  } else if (
    userRole === "Lead-Employee" ||
    userRole === "BO-Client" ||
    userRole === "Product-Manager"
  ) {
    /* all visible (same as legacy list) */
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
      { owner: rx },
      { contact: rx },
      { address: rx },
      { city: rx },
      { category: rx },
      { propertySourceName: rx },
      { roadName: rx },
      { shopNo: rx },
      { area: rx },
      { exactArea: rx },
      { expectedRent: rx },
      { rentType: rx },
      { possession: rx },
      { pinPointLocation: rx },
      { floor: rx },
      { frontageRoad: rx },
      { height: rx },
      { docklevelnoQty: rx },
      { fireSafety: rx },
      { washroomQty: rx },
      { floorStrength: rx },
      { lumsumRent: rx },
    ];
    if (userIds.length) {
      or.push({ whoCreated: { $in: userIds } });
      or.push({ whoLinkthis: { $in: userIds } });
    }
    clauses.push({ $or: or });
  }

  const filterList = parseFiltersList(req);
  for (const cond of filterList) {
    const piece = await buildOneFilterCondition(cond);
    if (piece) clauses.push(piece);
  }

  return {
    denied: false,
    match: clauses.length === 1 ? clauses[0] : { $and: clauses },
    select: propertySelectForRole(userRole),
  };
}

async function queryPropertiesPaginated(req, formatRow, { isArchive } = {}) {
  const built = await buildPropertyListMatch(req, Boolean(isArchive));
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
    Property.find(built.match)
      .select(built.select)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate("whoCreated", "name")
      .populate("whoLinkthis", "name")
      .lean(),
    Property.countDocuments(built.match),
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
  queryPropertiesPaginated,
};
