const mongoose = require("mongoose");
const Opportunity = require("../models/Opportunity");
const Client = require("../models/Client");
const Property = require("../models/propertyModel");
const User = require("../models/User");

const SITE_VISIT_DONE_TAG = "Site Visit Done";

const ALLOWED_SORT_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "status",
]);

const ALLOWED_FILTER_FIELDS = new Set([
  "status",
  "whoLinkthis",
  "createdAt",
  "client",
  "property",
  "siteVisitDone",
  "siteVisitDate",
  "followUpDate",
  "loaDate",
  "agreementDate",
  "previousStatus",
]);

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

function createdAtClause(operator, value, value2) {
  let op = operator;
  if (op === "greaterThan") op = "after";
  if (op === "lessThan") op = "before";
  const parseDay = (s) => {
    if (!s) return null;
    const d = new Date(s.length <= 10 ? `${s}T00:00:00.000Z` : s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const d1 = parseDay(value);
  const d2 = parseDay(value2);
  if (op === "equals" && d1) {
    const end = new Date(`${value}T23:59:59.999Z`);
    return { createdAt: { $gte: d1, $lte: end } };
  }
  if (op === "before" && d1) return { createdAt: { $lt: d1 } };
  if (op === "after" && d1) {
    return { createdAt: { $gt: new Date(`${value}T23:59:59.999Z`) } };
  }
  if (op === "between" && d1 && d2) {
    const end = new Date(`${value2}T23:59:59.999Z`);
    return { createdAt: { $gte: d1, $lte: end } };
  }
  return null;
}

/** siteVisitDate / followUpDate: match embedded comment dates */
function embeddedDateClause(field, operator, value, value2) {
  if (operator === "between" && value && value2) {
    const a = new Date(`${value}T00:00:00.000Z`);
    const b = new Date(`${value2}T23:59:59.999Z`);
    if (field === "siteVisitDate") {
      return {
        commentsSection: {
          $elemMatch: { "sitevisit.date": { $gte: a, $lte: b } },
        },
      };
    }
    return {
      commentsSection: {
        $elemMatch: { "followup.date": { $gte: a, $lte: b } },
      },
    };
  }
  if (!value) return null;
  const d0 = new Date(`${value}T00:00:00.000Z`);
  const d1 = new Date(`${value}T23:59:59.999Z`);
  if (operator === "equals") {
    if (field === "siteVisitDate") {
      return {
        commentsSection: {
          $elemMatch: { "sitevisit.date": { $gte: d0, $lte: d1 } },
        },
      };
    }
    return {
      commentsSection: {
        $elemMatch: { "followup.date": { $gte: d0, $lte: d1 } },
      },
    };
  }
  if (operator === "before") {
    const cut = new Date(`${value}T00:00:00.000Z`);
    if (field === "siteVisitDate") {
      return { commentsSection: { $elemMatch: { "sitevisit.date": { $lt: cut } } } };
    }
    return { commentsSection: { $elemMatch: { "followup.date": { $lt: cut } } } };
  }
  if (operator === "after") {
    const cut = new Date(`${value}T23:59:59.999Z`);
    if (field === "siteVisitDate") {
      return { commentsSection: { $elemMatch: { "sitevisit.date": { $gt: cut } } } };
    }
    return { commentsSection: { $elemMatch: { "followup.date": { $gt: cut } } } };
  }
  return null;
}

async function buildOneFilterCondition(cond) {
  if (!cond || typeof cond !== "object") return null;
  const field = queryStr(cond.field);
  let operator = normalizeOperator(cond.operator);
  let value =
    cond.value !== undefined && cond.value !== null
      ? String(cond.value).trim()
      : "";
  let value2 =
    cond.value2 !== undefined && cond.value2 !== null
      ? String(cond.value2).trim()
      : "";

  if (!field || !ALLOWED_FILTER_FIELDS.has(field)) return null;

  if (
    operator === "between" &&
    value &&
    !value2 &&
    String(value).includes("|")
  ) {
    const parts = String(value).split("|");
    value = parts[0]?.trim() || "";
    value2 = parts[1]?.trim() || "";
  }

  if (field === "createdAt") {
    if (operator === "greaterThan") operator = "after";
    if (operator === "lessThan") operator = "before";
  }

  if (field === "siteVisitDate" || field === "followUpDate") {
    if (operator === "greaterThan") operator = "after";
    if (operator === "lessThan") operator = "before";
  }

  if (field === "loaDate" || field === "agreementDate") {
    if (operator === "greaterThan") operator = "after";
    if (operator === "lessThan") operator = "before";
  }

  if (field === "siteVisitDone") {
    if (operator !== "equals") return null;
    const v = value.toLowerCase();
    if (v === "yes") {
      return {
        commentsSection: {
          $elemMatch: { tag: SITE_VISIT_DONE_TAG },
        },
      };
    }
    if (v === "no") {
      return {
        $nor: [
          {
            commentsSection: {
              $elemMatch: { tag: SITE_VISIT_DONE_TAG },
            },
          },
        ],
      };
    }
    return null;
  }

  if (field === "whoLinkthis") {
    if (operator === "equals") {
      const oid = parseObjectId(value);
      return oid ? { whoLinkthis: oid } : null;
    }
    return null;
  }

  if (field === "status") {
    return stringFieldClause("status", operator, value, value2);
  }

  if (field === "client") {
    if (operator === "between") return null;
    if (!value) return null;
    const esc = escapeRegex(value);
    const rx = new RegExp(
      operator === "equals"
        ? `^${esc}$`
        : operator === "startsWith"
          ? `^${esc}`
          : operator === "endsWith"
            ? `${esc}$`
            : esc,
      "i"
    );
    const ids = await Client.find({ name: rx }).distinct("_id").lean();
    if (!ids.length) return { client: { $in: [] } };
    return { client: { $in: ids } };
  }

  if (field === "property") {
    if (operator === "between") return null;
    if (!value) return null;
    const esc = escapeRegex(value);
    const rx = new RegExp(
      operator === "equals"
        ? `^${esc}$`
        : operator === "startsWith"
          ? `^${esc}`
          : operator === "endsWith"
            ? `${esc}$`
            : esc,
      "i"
    );
    const ids = await Property.find({ name: rx }).distinct("_id").lean();
    if (!ids.length) return { property: { $in: [] } };
    return { property: { $in: ids } };
  }

  if (field === "createdAt") {
    if (operator === "between" && (!value || !value2)) return null;
    if (operator !== "between" && !value) return null;
    return createdAtClause(operator, value, value2);
  }

  if (field === "siteVisitDate" || field === "followUpDate") {
    if (operator === "between" && (!value || !value2)) return null;
    if (operator !== "between" && !value) return null;
    return embeddedDateClause(field, operator, value, value2);
  }

  if (field === "loaDate") {
    if (operator === "between" && value && value2) {
      return {
        "loaDetails.dateOfLOI": {
          $gte: new Date(value),
          $lte: new Date(`${value2}T23:59:59.999Z`),
        },
      };
    }
    if (!value) return null;
    if (operator === "equals") {
      const d0 = new Date(`${value}T00:00:00.000Z`);
      const d1 = new Date(`${value}T23:59:59.999Z`);
      return { "loaDetails.dateOfLOI": { $gte: d0, $lte: d1 } };
    }
    if (operator === "before") {
      return { "loaDetails.dateOfLOI": { $lt: new Date(`${value}T00:00:00.000Z`) } };
    }
    if (operator === "after") {
      return { "loaDetails.dateOfLOI": { $gt: new Date(`${value}T23:59:59.999Z`) } };
    }
    return null;
  }

  if (field === "agreementDate") {
    if (operator === "between" && value && value2) {
      return {
        "agreementDetails.date": {
          $gte: new Date(value),
          $lte: new Date(`${value2}T23:59:59.999Z`),
        },
      };
    }
    if (!value) return null;
    if (operator === "equals") {
      const d0 = new Date(`${value}T00:00:00.000Z`);
      const d1 = new Date(`${value}T23:59:59.999Z`);
      return { "agreementDetails.date": { $gte: d0, $lte: d1 } };
    }
    if (operator === "before") {
      return { "agreementDetails.date": { $lt: new Date(`${value}T00:00:00.000Z`) } };
    }
    if (operator === "after") {
      return { "agreementDetails.date": { $gt: new Date(`${value}T23:59:59.999Z`) } };
    }
    return null;
  }

  if (field === "previousStatus") {
    if (operator !== "equals" && operator !== "contains") return null;
    if (!value) return null;
    const esc = escapeRegex(value);
    const rx = new RegExp(
      operator === "equals" ? `^${esc}$` : esc,
      "i"
    );
    return {
      $expr: {
        $regexMatch: {
          input: {
            $toLower: {
              $ifNull: [
                {
                  $let: {
                    vars: {
                      tags: {
                        $map: {
                          input: { $ifNull: ["$commentsSection", []] },
                          as: "c",
                          in: "$$c.tag",
                        },
                      },
                      len: { $size: { $ifNull: ["$commentsSection", []] } },
                    },
                    in: {
                      $cond: [
                        { $gte: ["$$len", 2] },
                        {
                          $arrayElemAt: [
                            "$$tags",
                            { $subtract: ["$$len", 2] },
                          ],
                        },
                        "",
                      ],
                    },
                  },
                },
                "",
              ],
            },
          },
          regex: rx.source,
          options: "i",
        },
      },
    };
  }

  return null;
}

function attachRolePopulates(query, role) {
  let q = query
    .populate("client")
    .populate({ path: "whoLinkthis", select: "name role" })
    .populate({ path: "verifiedProposalBy", select: "name role" })
    .populate({ path: "commentsSection.whoCommented", select: "name" })
    .populate({ path: "proposalEmailSentBy", select: "name role" });

  if (role === "BO-Client" || role === "Lead-Employee") {
    return q
      .select(
        "-propertyImages -insideViewImage -brochurePdf -planLayoutImage"
      )
      .populate({
        path: "property",
        select:
          "-propertyImages -insideViewImage -brochurePdf -planLayoutImage -address -contact -owner",
      });
  }
  if (role === "Product-Manager") {
    return q
      .select("-propertyImages -insideViewImage -brochurePdf -planLayoutImage")
      .populate({
        path: "property",
        select:
          "-propertyImages -insideViewImage -brochurePdf -planLayoutImage -address -contact -owner",
      })
      .populate({
        path: "client",
        select:
          "-name -email -contactDetails -contactPerson -owner -contactDetails -designation",
      });
  }
  return q.populate("property");
}

async function buildSearchFilterOnlyClauses(req) {
  const clauses = [];
  const trimmedQ = queryStr(req.query.q);
  if (trimmedQ) {
    const rx = new RegExp(escapeRegex(trimmedQ), "i");
    const clientIds = await Client.find({ name: rx }).distinct("_id").lean();
    const propIds = await Property.find({ name: rx }).distinct("_id").lean();
    const userIds = await User.find({ name: rx }).distinct("_id").lean();
    const or = [{ status: rx }];
    if (clientIds.length) or.push({ client: { $in: clientIds } });
    if (propIds.length) or.push({ property: { $in: propIds } });
    if (userIds.length) or.push({ whoLinkthis: { $in: userIds } });
    clauses.push({ $or: or });
  }
  const filterList = parseFiltersList(req);
  for (const cond of filterList) {
    const piece = await buildOneFilterCondition(cond);
    if (piece) clauses.push(piece);
  }
  return clauses;
}

async function buildOpportunityListMatch(req, role, userId) {
  const match = { isVisibility: true };
  if (role === "Lead-Employee") {
    match.whoLinkthis = userId;
  }

  const clauses = [match, ...(await buildSearchFilterOnlyClauses(req))];

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

async function queryOpportunitiesList(req) {
  const role = req.user.role;
  const userId = req.user._id;
  if (
    role !== "Super Admin" &&
    role !== "Manager" &&
    role !== "BO-Client" &&
    role !== "Lead-Employee" &&
    role !== "Product-Manager"
  ) {
    return { denied: true };
  }

  const page = parsePositiveInt(req.query.page, 1, 100000);
  const limit = parsePositiveInt(req.query.limit, 25, 100);
  const skip = (page - 1) * limit;

  const sortField = ALLOWED_SORT_FIELDS.has(req.query.sortBy)
    ? req.query.sortBy
    : "createdAt";
  const sortDir = req.query.sortOrder === "asc" ? 1 : -1;
  const sort = { [sortField]: sortDir };

  const mongoMatch = await buildOpportunityListMatch(req, role, userId);

  let baseQuery = Opportunity.find(mongoMatch)
    .select("-propertyImages -insideViewImage -brochurePdf -planLayoutImage")
    .sort(sort)
    .skip(skip)
    .limit(limit);

  baseQuery = attachRolePopulates(baseQuery, role);

  const [data, total] = await Promise.all([
    baseQuery.lean(),
    Opportunity.countDocuments(mongoMatch),
  ]);

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
  queryOpportunitiesList,
  buildSearchFilterOnlyClauses,
  buildOneFilterCondition,
  escapeRegex,
  queryStr,
  parsePositiveInt,
  parseFiltersList,
  normalizeOperator,
};
