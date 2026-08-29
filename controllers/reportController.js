const mongoose = require("mongoose");
const User = require("../models/User");
const Opportunity = require("../models/Opportunity");
const Property = require("../models/propertyModel");
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const { countOpportunityStages } = require("../utils/adminFunnelStages");
const {
  startOfDayIST,
  endOfDayIST,
} = require("../services/insights/periodUtils");

const TAT_REPORT_ROLES = ["Super Admin", "Manager", "BO-Client"];

function tatDaysBetween(later, earlier) {
  if (!later || !earlier) return null;
  const ms = new Date(later).getTime() - new Date(earlier).getTime();
  if (ms < 0) return null;
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

/**
 * Same rule as the TAT "Opportunity to Site visit" count:
 * earliest comment with sitevisit.date, else earliest comment whose tag contains "site visit".
 */
function earliestSiteVisitFromComments(comments) {
  if (!Array.isArray(comments) || !comments.length) return null;
  let best = null;
  for (const comment of comments) {
    let siteVisitDate = null;
    let source = "";
    if (comment?.sitevisit?.date) {
      siteVisitDate = comment.sitevisit.date;
      source = "sitevisit.date";
    } else if (typeof comment.tag === "string" && comment.tag.toLowerCase().includes("site visit")) {
      siteVisitDate = comment.createdAt;
      source = "status tag";
    }
    if (!siteVisitDate) continue;
    if (!best || new Date(siteVisitDate) < new Date(best.siteVisitDate)) {
      best = {
        siteVisitDate,
        markedAt: comment.createdAt || null,
        markedByName: comment.whoCommented?.name || "",
        tag: comment.tag || "",
        isDone: Boolean(comment.sitevisit?.isDone),
        source,
      };
    }
  }
  return best;
}

function formatIstDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function assertTatReportAccess(user) {
  if (!user || !TAT_REPORT_ROLES.includes(user.role)) {
    const err = new Error("Access denied.");
    err.status = 403;
    return err;
  }
  return null;
}

// Turnaround Time (TAT) Report
exports.getTatReport = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!["Super Admin", "Manager", "BO-Client"].includes(userRole)) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const dateFilter = resolveDateRange(req.query);

    // Load needed collections
    const leads = await Lead.find({ ...dateFilter }).select("_id createdAt convertedAt convertedTo");
    const clients = await Client.find({ ...dateFilter }).select("_id createdAt opportunities linkedProperties");
    const opportunities = await Opportunity.find({ ...dateFilter })
      .select("_id client property createdAt commentsSection loaDetails agreementDetails");
    const properties = await Property.find({ ...dateFilter }).select("_id createdAt linkedClients");

    // Index helpers
    const leadByClientId = new Map();
    leads.forEach(lead => {
      if (lead.convertedTo) leadByClientId.set(String(lead.convertedTo), lead);
    });
    const clientById = new Map(clients.map(c => [String(c._id), c]));
    
    // Map: clientId -> first opportunity (which represents first property link)
    const firstOpportunityByClient = new Map();
    opportunities.forEach(opp => {
      const clientId = String(opp.client);
      if (!firstOpportunityByClient.has(clientId)) {
        firstOpportunityByClient.set(clientId, opp);
      } else {
        const existing = firstOpportunityByClient.get(clientId);
        if (new Date(opp.createdAt) < new Date(existing.createdAt)) {
          firstOpportunityByClient.set(clientId, opp);
        }
      }
    });

    const pipelineStatuses = [
      "Asking more details of property ( Pictures / Video / Data )",
      "Property Approved but Board Approval Pending",
      "Property is ok - Negotiate Rent",
      "Planning for Site Visit",
      "Looking for Capex Investor",
      "Site-visit-Negative",
      "Site-visit-Positive",
      "One More Visit",
      "LOI",
      "Owner Side Pending",
      "Commercial Details Shared",
      "Find Franchise Investor",
      "Property Approved",
      "Site Visit Done",
      "Loi Received"
    ];

    function daysBetween(a, b) {
      return tatDaysBetween(a, b);
    }

    const accum = {
      leadToClient: [],
      clientToOpportunity: [], // Client to Opportunity (when property is linked, opportunity is auto-created)
      opportunityToPipeline: [],
      opportunityToSiteVisit: [],
      siteVisitToLoi: [],
      loiToAgreement: [],
      leadToAgreement: []
    };

    // Lead -> Client
    // If client came from lead: show actual time from lead to client
    // If client was copied (no lead): show 1 day
    clients.forEach(client => {
      const lead = leadByClientId.get(String(client._id));
      if (lead) {
        // Client came from a lead - calculate actual time
        const d = daysBetween(client.createdAt, lead.createdAt);
        if (d != null) accum.leadToClient.push(d);
      } else {
        // Client was copied/created directly (no lead) - show as 1 day
        accum.leadToClient.push(1);
      }
    });

    // Client -> Opportunity
    // When client is linked to property, opportunity is automatically created
    // Track time from client creation to first opportunity creation
    // INCLUDES ALL CLIENTS: both converted from leads AND copied/created directly
    firstOpportunityByClient.forEach((firstOpp, clientId) => {
      const client = clientById.get(clientId);
      if (client) {
        // Time from client creation to first opportunity (which happens when property is linked)
        // This includes ALL clients regardless of source (converted leads or copied clients)
        const d = daysBetween(firstOpp.createdAt, client.createdAt);
        if (d != null) accum.clientToOpportunity.push(d);
      }
    });

    // Opportunity -> Pipeline, Site Visit, LOI, Agreement (per opportunity)
    // INCLUDES ALL OPPORTUNITIES: from both converted leads AND copied clients
    for (const opp of opportunities) {
      const client = clientById.get(String(opp.client));

      // Opportunity -> Pipeline (first pipeline comment date)
      let firstPipelineDate = null;
      if (Array.isArray(opp.commentsSection) && opp.commentsSection.length) {
        for (const c of opp.commentsSection) {
          if (pipelineStatuses.includes(c.tag)) {
            if (!firstPipelineDate || new Date(c.createdAt) < new Date(firstPipelineDate)) {
              firstPipelineDate = c.createdAt;
            }
          }
        }
      }
      const d2 = daysBetween(firstPipelineDate, opp.createdAt);
      if (d2 != null) accum.opportunityToPipeline.push(d2);

      // Opportunity -> Site Visit — same rule as Excel export
      const siteVisit = earliestSiteVisitFromComments(opp.commentsSection);
      const siteVisitDate = siteVisit?.siteVisitDate || null;
      const d3 = daysBetween(siteVisitDate, opp.createdAt);
      if (d3 != null) accum.opportunityToSiteVisit.push(d3);

      // Site Visit -> LOI
      const loiDate = opp?.loaDetails?.dateOfLOI || opp?.loaDetails?.whenCreated || null;
      const d4 = daysBetween(loiDate, siteVisitDate);
      if (d4 != null) accum.siteVisitToLoi.push(d4);

      // LOI -> Agreement
      const agreementDate = opp?.agreementDetails?.date || opp?.agreementDetails?.whenCreated || null;
      const d5 = daysBetween(agreementDate, loiDate);
      if (d5 != null) accum.loiToAgreement.push(d5);

      // Lead -> Agreement (only if client came from a lead)
      if (client) {
        const linkedLead = leadByClientId.get(String(client._id));
        if (linkedLead) {
          const d6 = daysBetween(agreementDate, linkedLead.createdAt);
          if (d6 != null) accum.leadToAgreement.push(d6);
        }
      }
    }

    function avg(arr) {
      if (!arr.length) return null;
      // Round to whole number for cleaner display (round to nearest integer)
      return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    }

    const response = [
      { metric: 'Lead to Client', count: accum.leadToClient.length, averageDays: avg(accum.leadToClient) },
      { metric: 'Client to Opportunity', count: accum.clientToOpportunity.length, averageDays: avg(accum.clientToOpportunity) },
      { metric: 'Opportunity to Pipeline', count: accum.opportunityToPipeline.length, averageDays: avg(accum.opportunityToPipeline) },
      { metric: 'Opportunity to Site visit', count: accum.opportunityToSiteVisit.length, averageDays: avg(accum.opportunityToSiteVisit) },
      { metric: 'Site visit to LOI', count: accum.siteVisitToLoi.length, averageDays: avg(accum.siteVisitToLoi) },
      { metric: 'Loi to Agreement', count: accum.loiToAgreement.length, averageDays: avg(accum.loiToAgreement) },
      { metric: 'Lead to Agreement', count: accum.leadToAgreement.length, averageDays: avg(accum.leadToAgreement) }
    ];

    res.status(200).json({ success: true, period: req.query.period || 'custom', table: response });
  } catch (error) {
    console.error('Error generating TAT report:', error);
    res.status(500).json({ success: false, message: 'Error generating TAT report', error: error.message });
  }
};
// Raw bounds { $gte, $lte } for the selected period, or null when no date filter (all time)
function parseYmdDate(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const [y, m, d] = trimmed.split("-").map(Number);
  if (!y || !m || !d) return null;
  // Construct as UTC noon then snap to IST day bounds via helpers
  const approx = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (Number.isNaN(approx.getTime())) return null;
  return approx;
}

function buildBoundsFromYmd(startDate, endDate) {
  if (!startDate && !endDate) return null;
  const range = {};
  if (startDate) {
    const start = parseYmdDate(startDate);
    if (!start) return null;
    range.$gte = startOfDayIST(start);
  }
  if (endDate) {
    const end = parseYmdDate(endDate);
    if (!end) return null;
    range.$lte = endOfDayIST(end);
  }
  if (range.$gte && range.$lte && range.$gte > range.$lte) {
    return null;
  }
  return range;
}

function formatBoundsLabel(bounds) {
  if (!bounds) return "All time";
  const fmt = (d) =>
    d.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    });
  if (bounds.$gte && bounds.$lte) return `${fmt(bounds.$gte)} – ${fmt(bounds.$lte)}`;
  if (bounds.$gte) return `From ${fmt(bounds.$gte)}`;
  if (bounds.$lte) return `Until ${fmt(bounds.$lte)}`;
  return "Custom";
}

function mergeDateBounds(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    $gte:
      a.$gte && b.$gte
        ? a.$gte < b.$gte
          ? a.$gte
          : b.$gte
        : a.$gte || b.$gte,
    $lte:
      a.$lte && b.$lte
        ? a.$lte > b.$lte
          ? a.$lte
          : b.$lte
        : a.$lte || b.$lte,
  };
}

function buildFunnelComparisonPayload(
  currentSteps,
  previousSteps,
  currentLabel,
  previousLabel
) {
  const prevByKey = new Map((previousSteps || []).map((s) => [s.key, s]));
  return {
    enabled: true,
    currentLabel,
    previousLabel,
    steps: (currentSteps || []).map((step) => {
      const prev = prevByKey.get(step.key);
      const previousRatio = prev?.ratio ?? null;
      const ratioDelta =
        step.ratio != null && previousRatio != null
          ? Math.round((step.ratio - previousRatio) * 10) / 10
          : null;
      return {
        key: step.key,
        count: step.count ?? 0,
        previousCount: prev?.count ?? 0,
        ratio: step.ratio ?? null,
        previousRatio,
        ratioDelta,
        meta: step.meta || null,
        previousMeta: prev?.meta || null,
      };
    }),
  };
}

function buildDateRangeBounds(query) {
  const { startDate, endDate, period } = query || {};
  if (startDate || endDate) {
    return buildBoundsFromYmd(startDate, endDate);
  }

  const timePeriod = period || query?.timePeriod; // support existing keys
  if (!timePeriod || timePeriod === "all") return null;

  const now = new Date();
  let start = new Date();
  let end = new Date();

  switch (timePeriod) {
    case "day":
    case "today": {
      return { $gte: startOfDayIST(now), $lte: endOfDayIST(now) };
    }
    case "week": {
      // Current IST calendar week (Mon–Sun)
      const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      const day = istNow.getUTCDay(); // 0 Sun … 6 Sat in IST frame
      const daysFromMonday = day === 0 ? 6 : day - 1;
      const monday = startOfDayIST(
        new Date(now.getTime() - daysFromMonday * 24 * 60 * 60 * 1000)
      );
      const sunday = endOfDayIST(
        new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000)
      );
      return { $gte: monday, $lte: sunday };
    }
    case "month": {
      const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      const y = istNow.getUTCFullYear();
      const m = istNow.getUTCMonth();
      start = startOfDayIST(new Date(Date.UTC(y, m, 1, 12)));
      end = endOfDayIST(new Date(Date.UTC(y, m + 1, 0, 12)));
      return { $gte: start, $lte: end };
    }
    case "quarter": {
      const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      const y = istNow.getUTCFullYear();
      const q = Math.floor(istNow.getUTCMonth() / 3);
      start = startOfDayIST(new Date(Date.UTC(y, q * 3, 1, 12)));
      end = endOfDayIST(new Date(Date.UTC(y, q * 3 + 3, 0, 12)));
      return { $gte: start, $lte: end };
    }
    case "year": {
      const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      const y = istNow.getUTCFullYear();
      start = startOfDayIST(new Date(Date.UTC(y, 0, 1, 12)));
      end = endOfDayIST(new Date(Date.UTC(y, 11, 31, 12)));
      return { $gte: start, $lte: end };
    }
    default:
      return null;
  }
}

/** Previous period of equal length immediately before current bounds (for preset compare). */
function buildPreviousEqualBounds(currentBounds) {
  if (!currentBounds?.$gte || !currentBounds?.$lte) return null;
  const durationMs = currentBounds.$lte.getTime() - currentBounds.$gte.getTime();
  const prevEnd = new Date(currentBounds.$gte.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - durationMs);
  return {
    $gte: startOfDayIST(prevStart),
    $lte: endOfDayIST(prevEnd),
  };
}

function buildCompareDateRangeBounds(query) {
  const compareStart = query?.compareStartDate || query?.startDateB;
  const compareEnd = query?.compareEndDate || query?.endDateB;
  if (!compareStart && !compareEnd) return null;
  return buildBoundsFromYmd(compareStart, compareEnd);
}

// Utility: resolve time filter from startDate/endDate/period (Lead/Client createdAt, Opportunity createdAt, etc.)
function resolveDateRange(query) {
  const bounds = buildDateRangeBounds(query);
  if (!bounds) return {};
  return { createdAt: bounds };
}

// Same calendar window as resolveDateRange, applied to Lead.convertedAt
function resolveConvertedAtRange(query) {
  const bounds = buildDateRangeBounds(query);
  if (!bounds) return {};
  return { convertedAt: bounds };
}

function toConvertedBounds(bounds) {
  if (!bounds) return {};
  return { convertedAt: bounds };
}

/**
 * Excel of every opportunity included in TAT "Opportunity to Site visit".
 * Row count matches the aggregate Completed Count for the same period filter.
 */
exports.getTatSiteVisitExport = async (req, res) => {
  try {
    const denied = assertTatReportAccess(req.user);
    if (denied) {
      return res.status(403).json({ success: false, message: denied.message });
    }

    const dateFilter = resolveDateRange(req.query);
    const bounds = buildDateRangeBounds(req.query);
    const periodLabel = formatBoundsLabel(bounds);

    const opportunities = await Opportunity.find({ ...dateFilter })
      .populate("client", "name")
      .populate("property", "name")
      .populate("commentsSection.whoCommented", "name")
      .select("_id client property createdAt commentsSection")
      .lean();

    const rows = [];
    const dayValues = [];
    for (const opp of opportunities) {
      const siteVisit = earliestSiteVisitFromComments(opp.commentsSection);
      const days = tatDaysBetween(siteVisit?.siteVisitDate, opp.createdAt);
      if (days == null) continue;
      dayValues.push(days);
      rows.push({
        "#": rows.length + 1,
        "Opportunity ID": String(opp._id),
        "Client Name": opp.client?.name || "",
        "Property Name": opp.property?.name || "",
        "Opportunity Created": formatIstDateTime(opp.createdAt),
        "Site Visit Date": formatIstDateTime(siteVisit.siteVisitDate),
        "Marked At": formatIstDateTime(siteVisit.markedAt),
        "Marked By": siteVisit.markedByName || "",
        "Status Tag": siteVisit.tag || "",
        "Site Visit Done": siteVisit.isDone ? "Yes" : "No",
        "Date source": siteVisit.source,
        "Days (Opp → Site Visit)": days,
      });
    }

    const averageDays = dayValues.length
      ? Math.round(dayValues.reduce((a, b) => a + b, 0) / dayValues.length)
      : "";

    const XLSX = require("xlsx");
    const workbook = XLSX.utils.book_new();
    const howCount = XLSX.utils.aoa_to_sheet([
      ["TAT Report — Opportunity to Site visit"],
      ["Period", periodLabel],
      ["Count (same as Completed Count)", rows.length],
      ["Average days", averageDays],
      [],
      ["How this count is calculated"],
      ["1. Each opportunity created in the selected period is checked once."],
      ["2. It is counted if a comment has a Site Visit date (sitevisit.date) OR a status tag containing \"site visit\"."],
      ["3. Site Visit Date = the earliest of those dates on that opportunity."],
      ["4. Marked At = when that comment was saved."],
      ["5. Days = ceil((Site Visit Date − Opportunity Created) in days)."],
      ["6. If Site Visit Date is before Opportunity Created, that opportunity is NOT counted."],
    ]);
    howCount["!cols"] = [{ wch: 78 }, { wch: 28 }];
    XLSX.utils.book_append_sheet(workbook, howCount, "How count works");

    const detailSheet = XLSX.utils.json_to_sheet(rows);
    detailSheet["!cols"] = [
      { wch: 6 },
      { wch: 26 },
      { wch: 28 },
      { wch: 28 },
      { wch: 22 },
      { wch: 22 },
      { wch: 22 },
      { wch: 22 },
      { wch: 28 },
      { wch: 16 },
      { wch: 16 },
      { wch: 22 },
    ];
    XLSX.utils.book_append_sheet(workbook, detailSheet, "Opportunities");

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const filename = `tat-opportunity-to-site-visit.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buffer);
  } catch (error) {
    console.error("Error exporting TAT site-visit Excel:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to export Opportunity to Site visit Excel",
    });
  }
};

// Get tag-based opportunity reports
exports.getTagReports = async (req, res) => {
  try {
    // Check user authorization
    const userRole = req.user.role;
    if (!["Super Admin", "Manager", "BO-Client"].includes(userRole)) {
      return res.status(403).json({ 
        success: false, 
        message: "Access denied. You don't have permission to view reports." 
      });
    }

    const dateFilter = resolveDateRange(req.query);
    
    // Find opportunities within the time period
    const opportunities = await Opportunity.find({
      ...dateFilter
    });
    
    const allTags = [
      "In Evaluation",
      "Need more details of property (Pictures/video/Data)",
      "Property Approved but Board Approval Pending",
      "Property is ok - Negotiate Rent",
      "Keep this option on Hold",
      "Planning for Site Visit",
      "Site-visit-Positive",
      "Site-visit-Hold",
      "Site-visit-Negative",
      "Already Received from other consultant",
      "Height issue",
      "Frontage issue",
      "Size issue",
      "Rental issue",
      "Not suitable",
      "Looking for Better Option",
      "Hold", 
      "One More Visit",
      "Keep on Hold", 
      "Keep on hold", 
      "Follow Up", 
      "Reject",
      "Approved", 
      "LOI", 
      "Agreement",
      "Pending", 
      "Win", 
      "Call", 
      "Loss"
    ];

    // Initialize tag counts
    const tagCounts = {};
    allTags.forEach(tag => {
      tagCounts[tag] = 0;
    });

    // Count opportunities by status
    opportunities.forEach(opportunity => {
      if (tagCounts.hasOwnProperty(opportunity.status)) {
        tagCounts[opportunity.status]++;
      }
    });

    // Format the response for table view
    const formattedReport = Object.entries(tagCounts)
      .filter(([_, count]) => count > 0) // Only include tags with at least one opportunity
      .map(([tag, count]) => ({
        tag,
        count
      }));

    // Format data for graph visualization
    const graphData = {
      labels: formattedReport.map(item => item.tag),
      datasets: [{
        label: 'Number of Opportunities',
        data: formattedReport.map(item => item.count),
      }]
    };

    res.status(200).json({
      success: true,
      period: req.query.period || 'custom',
      totalOpportunities: opportunities.length,
      tableData: formattedReport,
      graphData: graphData
    });
  } catch (error) {
    console.error("Error generating tag reports:", error);
    res.status(500).json({
      success: false,
      message: "Error generating tag reports",
      error: error.message
    });
  }
};
 
// Get lead generation report by Lead Employees
exports.getLeadGenerationReport = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!["Super Admin", "Manager", "BO-Client"].includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: "Access denied."
      });
    }

    const dateFilter = resolveDateRange(req.query);
    const convertedDateFilter = resolveConvertedAtRange(req.query);

    // Client _ids that are the result of a lead→client conversion (exclude from "copy / direct" bucket)
    const convertedClientIds = await Lead.distinct("convertedTo", {
      convertedTo: { $exists: true, $ne: null }
    });

    const buildRow = async (userDoc) => {
      const uid = userDoc._id;
      const leadsGenerated = await Lead.countDocuments({
        createdBy: uid,
        ...dateFilter
      });
      const leadsConvertedToClient = await Lead.countDocuments({
        whoConverted: uid,
        isConverted: true,
        ...convertedDateFilter
      });
      const clientsCopyOrDirect = await Client.countDocuments({
        whoConverted: uid,
        ...dateFilter,
        ...(convertedClientIds.length
          ? { _id: { $nin: convertedClientIds } }
          : {})
      });
      const totalClients = leadsConvertedToClient + clientsCopyOrDirect;
      return {
        name: userDoc.name,
        leadsGenerated,
        leadsConvertedToClient,
        clientsCopyOrDirect,
        totalClients
      };
    };

    // Get all users with relevant roles for lead generation reporting
    const users = await User.find({
      role: { $in: ["Lead-Employee", "BO-Client", "Super Admin", "Manager"] }
    }).select("_id name role");

    const leadEmployees = users.filter((user) => user.role === "Lead-Employee");
    const boClients = users.filter((user) => user.role === "BO-Client");
    const superAdmins = users.filter((user) => user.role === "Super Admin");
    const managers = users.filter((user) => user.role === "Manager");

    const roleWiseReport = {
      leadEmployees: [],
      boClients: [],
      superAdmins: [],
      managers: []
    };

    for (const employee of leadEmployees) {
      roleWiseReport.leadEmployees.push(await buildRow(employee));
    }
    for (const client of boClients) {
      roleWiseReport.boClients.push(await buildRow(client));
    }
    for (const admin of superAdmins) {
      roleWiseReport.superAdmins.push(await buildRow(admin));
    }
    for (const manager of managers) {
      roleWiseReport.managers.push(await buildRow(manager));
    }

    const sortRoleRows = (rows) =>
      rows.sort((a, b) => {
        if (b.totalClients !== a.totalClients) return b.totalClients - a.totalClients;
        if (b.leadsConvertedToClient !== a.leadsConvertedToClient) {
          return b.leadsConvertedToClient - a.leadsConvertedToClient;
        }
        return b.leadsGenerated - a.leadsGenerated;
      });

    Object.keys(roleWiseReport).forEach((role) => sortRoleRows(roleWiseReport[role]));

    const datasetColors = [
      { bg: "rgba(75, 192, 192, 0.5)", border: "rgba(75, 192, 192, 1)" },
      { bg: "rgba(54, 162, 235, 0.5)", border: "rgba(54, 162, 235, 1)" },
      { bg: "rgba(255, 159, 64, 0.5)", border: "rgba(255, 159, 64, 1)" },
      { bg: "rgba(153, 102, 255, 0.5)", border: "rgba(153, 102, 255, 1)" }
    ];

    const graphData = {};
    Object.keys(roleWiseReport).forEach((role) => {
      const rows = roleWiseReport[role];
      graphData[role] = {
        labels: rows.map((item) => item.name),
        datasets: [
          {
            label: "Leads created",
            data: rows.map((item) => item.leadsGenerated),
            backgroundColor: datasetColors[0].bg,
            borderColor: datasetColors[0].border,
            borderWidth: 1
          },
          {
            label: "Converted to client (from lead)",
            data: rows.map((item) => item.leadsConvertedToClient),
            backgroundColor: datasetColors[1].bg,
            borderColor: datasetColors[1].border,
            borderWidth: 1
          },
          {
            label: "Clients (copy / direct create)",
            data: rows.map((item) => item.clientsCopyOrDirect),
            backgroundColor: datasetColors[2].bg,
            borderColor: datasetColors[2].border,
            borderWidth: 1
          },
          {
            label: "Total clients (converted + copy/direct)",
            data: rows.map((item) => item.totalClients),
            backgroundColor: datasetColors[3].bg,
            borderColor: datasetColors[3].border,
            borderWidth: 1
          }
        ]
      };
    });

    const period =
      req.query.startDate || req.query.endDate
        ? "custom"
        : req.query.period || "week";

    res.status(200).json({
      success: true,
      period: period,
      data: roleWiseReport,
      graphData: graphData
    });
  } catch (error) {
    console.error("Error generating lead generation report:", error);
    res.status(500).json({
      success: false,
      message: "Error generating lead generation report",
      error: error.message
    });
  }
};

// Lead to Opportunity Conversion Report

exports.leadToOpportunityReport = async (req, res) => {
  try {
    // Check user authorization
    const { role } = req.user;
    if (!["Super Admin", "Manager", "BO-Client"].includes(role)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to access this report"
      });
    }

    // Get priority filter and time period from query params if provided
    const { priority, timePeriod } = req.query;
    
    // Define valid priorities
    const priorities = ['High', 'Medium', 'Low', 'Cold', 'Hot'];
    
    // Calculate start date based on time period
    let startDate = new Date(0); // Default to epoch time
    const currentDate = new Date();
    
    if (timePeriod) {
      switch (timePeriod.toLowerCase()) {
        case 'week':
          startDate = new Date(currentDate);
          startDate.setDate(currentDate.getDate() - 7);
          break;
        case 'month':
          startDate = new Date(currentDate);
          startDate.setMonth(currentDate.getMonth() - 1);
          break;
        case 'quarter':
          startDate = new Date(currentDate);
          startDate.setMonth(currentDate.getMonth() - 3);
          break;
        case 'year':
          startDate = new Date(currentDate);
          startDate.setFullYear(currentDate.getFullYear() - 1);
          break;
        case 'all':
        default:
          startDate = new Date(0); // All time (epoch)
          break;
      }
    }

    // Resolve optional custom date range
    const dateFilter = resolveDateRange(req.query);
    
    // Initialize report data
    const reportData = {};
    
    // For each priority, calculate metrics
    for (const priority of priorities) {
      // Find clients with this priority created after the start date or within custom range
      const baseQuery = { priority };
      const clients = await Client.find(
        Object.keys(dateFilter).length ? { ...baseQuery, ...dateFilter } : { ...baseQuery, createdAt: { $gte: startDate } }
      );
      
      // Count clients with this priority
      const leadCount = clients.length;
      
      // Count opportunities from these clients
      let opportunityCount = 0;
      
      for (const client of clients) {
        if (client.opportunities) {
          opportunityCount += client.opportunities.length;
        }
      }
      
      // Calculate conversion ratio
      const conversionRatio = leadCount > 0 ? ((opportunityCount / leadCount) * 100).toFixed(2) : 0;
      
      // Add to report data
      reportData[priority] = {
        numberOfLeads: leadCount,
        numberOfOpportunities: opportunityCount,
        conversionRatio: `${conversionRatio}%`
      };
    }
    
    // Calculate totals
    let totalOpportunities = 0;
    let totalLeads = 0;
    
    // Get all clients within the time period
    const allClients = await Client.find(Object.keys(dateFilter).length ? { ...dateFilter } : { createdAt: { $gte: startDate } });
    totalLeads = allClients.length;
    
    // Sum up opportunities from all clients
    for (const client of allClients) {
      if (client.opportunities) {
        totalOpportunities += client.opportunities.length;
      }
    }
    
    const totalConversionRatio = totalLeads > 0 ? ((totalOpportunities / totalLeads) * 100).toFixed(2) : 0;
    
    reportData.Total = {
      numberOfLeads: totalLeads,
      numberOfOpportunities: totalOpportunities,
      conversionRatio: `${totalConversionRatio}%`
    };

    // Prepare graph data
    const graphData = {
      labels: [...priorities, 'Total'],
      datasets: [
        {
          label: 'Number of Leads',
          data: [...priorities.map(p => reportData[p].numberOfLeads), reportData.Total.numberOfLeads]
        },
        {
          label: 'Number of Opportunities',
          data: [...priorities.map(p => reportData[p].numberOfOpportunities), reportData.Total.numberOfOpportunities]
        },
        {
          label: 'Conversion Ratio (%)',
          data: [...priorities.map(p => parseFloat(reportData[p].conversionRatio)), parseFloat(reportData.Total.conversionRatio)]
        }
      ]
    };

    // Time series data for trends (last 6 months)
    const timeSeriesData = [];
    for (let i = 5; i >= 0; i--) {
      const monthStartDate = new Date(currentDate);
      monthStartDate.setMonth(currentDate.getMonth() - i);
      monthStartDate.setDate(1);
      monthStartDate.setHours(0, 0, 0, 0);
      
      const monthEndDate = new Date(monthStartDate);
      monthEndDate.setMonth(monthStartDate.getMonth() + 1);
      monthEndDate.setDate(0);
      monthEndDate.setHours(23, 59, 59, 999);
      
      const monthClients = await Client.find({
        createdAt: { $gte: monthStartDate, $lte: monthEndDate }
      });
      
      let monthOpportunities = 0;
      for (const client of monthClients) {
        if (client.opportunities) {
          monthOpportunities += client.opportunities.length;
        }
      }
      
      const monthConversionRatio = monthClients.length > 0 ? 
        ((monthOpportunities / monthClients.length) * 100).toFixed(2) : 0;
      
      const monthName = monthStartDate.toLocaleString('default', { month: 'short' });
      const year = monthStartDate.getFullYear();
      
      timeSeriesData.push({
        period: `${monthName} ${year}`,
        leads: monthClients.length,
        opportunities: monthOpportunities,
        conversionRatio: `${monthConversionRatio}%`
      });
    }

    res.status(200).json({
      success: true,
      timePeriod: req.query.period || 'custom',
      data: reportData,
      graphData: graphData,
      timeSeriesData: timeSeriesData
    });
  } catch (error) {
    console.error("Error generating lead to opportunity report:", error);
    res.status(500).json({
      success: false,
      message: "Error generating lead to opportunity report",
      error: error.message
    });
  }
};

// Generate brand-wise report
exports.generateBrandwiseReport = async (req, res) => {
  try {
    // Check user authorization
    const userRole = req.user.role;
    if (!["Super Admin", "Manager", "BO-Client"].includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to access this report"
      });
    }

    // Apply date filter
    const dateFilter = resolveDateRange(req.query);

    // Apply brand and city filters from query parameters
    const brandFilter = req.query.brand && req.query.brand.trim() ? { name: req.query.brand.trim() } : {};
    const cityFilter = req.query.city && req.query.city.trim() ? { city: req.query.city.trim() } : {};

    // Combine all filters
    const filterCriteria = {
      ...dateFilter,
      ...brandFilter,
      ...cityFilter
    };

    // Fetch all clients with populated data
    const clients = await Client.find(filterCriteria)
      .populate('whoConverted', 'name')
      .populate({
        path: 'opportunities',
        select: 'property status createdAt whoLinkthis commentsSection',
        populate: [
          {
            path: 'property',
            select: 'name address area expectedRent createdAt' // Added createdAt to ensure it's selected
          },
          {
            path: 'whoLinkthis',
            select: 'name'
          }
        ]
      })
      .populate('linkedProperties', 'name address area expectedRent createdAt') // Added createdAt to ensure it's selected
      .select('name contactPerson email priority city createdAt whoConverted opportunities linkedProperties');

    // Group clients by brand name
    const brandwiseReport = {};

    clients.forEach(client => {
      const brandName = client.name;
      
      if (!brandwiseReport[brandName]) {
        brandwiseReport[brandName] = {
          totalClients: 0,
          clients: []
        };
      }
      
      // Increment client count for this brand
      brandwiseReport[brandName].totalClients++;
      
      // Add client details
      const clientData = {
        id: client._id,
        contactPerson: client.contactPerson,
        email: client.email,
        city: client.city, // Ensure city is included in the response
        priority: client.priority,
        createdAt: client.createdAt,
        convertedBy: client.whoConverted ? client.whoConverted.name : 'N/A',
        linkedProperties: client.linkedProperties.map(prop => ({
          id: prop._id,
          name: prop.name,
          address: prop.address,
          createdAt: prop.createdAt, // This will now be included in the response
          area: prop.area,
          expectedRent: prop.expectedRent
        })),
        opportunities: client.opportunities.map(opp => ({
          id: opp._id,
          property: opp.property ? {
            id: opp.property._id,
            name: opp.property.name,
            address: opp.property.address,
            createdAt: opp.property.createdAt // Added property createdAt to ensure it's included
          } : 'N/A',
          status: opp.status,
          createdAt: opp.createdAt, // Ensure createdAt is included in the response
          linkedBy: opp.whoLinkthis ? opp.whoLinkthis.name : 'N/A',
          latestComment: opp.commentsSection && opp.commentsSection.length > 0 ? 
            opp.commentsSection[opp.commentsSection.length - 1].comment : 'No comments'
        }))
      };
      
      brandwiseReport[brandName].clients.push(clientData);
    });

    // Add summary statistics for each brand
    Object.keys(brandwiseReport).forEach(brand => {
      const brandData = brandwiseReport[brand];
      let totalOpportunities = 0;
      let approvedOpportunities = 0;
      let pendingOpportunities = 0;
      let rejectedOpportunities = 0;
      
      brandData.clients.forEach(client => {
        totalOpportunities += client.opportunities.length;
        
        client.opportunities.forEach(opp => {
          if (["Approved", "LOI", "Agreement", "Win"].includes(opp.status)) {
            approvedOpportunities++;
          } else if (["Reject", "Loss", "Not suitable"].includes(opp.status)) {
            rejectedOpportunities++;
          } else {
            pendingOpportunities++;
          }
        });
      });
      
      brandData.summary = {
        totalOpportunities,
        approvedOpportunities,
        pendingOpportunities,
        rejectedOpportunities,
        conversionRate: totalOpportunities > 0 ? 
          ((approvedOpportunities / totalOpportunities) * 100).toFixed(2) + '%' : '0%'
      };
    });

    // Provide distinct filters for frontend
    const distinctCities = await Client.distinct('city');
    const distinctBrands = await Client.distinct('name');

    res.status(200).json({
      success: true,
      data: brandwiseReport,
      filters: {
        cities: distinctCities,
        brands: distinctBrands
      }
    });
  } catch (error) {
    console.error("Error generating brand-wise report:", error);
    res.status(500).json({
      success: false,
      message: "Error generating brand-wise report",
      error: error.message
    });
  }
};

// Get available brands for filtering
exports.getAvailableBrands = async (req, res) => {
  try {
    // Check user authorization
    const userRole = req.user.role;
    if (!["Super Admin", "Manager", "BO-Client"].includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to access this resource"
      });
    }

    // Get distinct brand names from Client collection
    const brands = await Client.distinct('name');
    
    // Sort and filter out empty/null brands
    const sortedBrands = brands
      .filter(brand => brand && brand.trim())
      .sort();

    res.status(200).json({
      success: true,
      brands: sortedBrands
    });
  } catch (error) {
    console.error("Error fetching available brands:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching available brands",
      error: error.message
    });
  }
};


exports.generateCityWiseReport = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!["Super Admin", "Manager", "BO-Client"].includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to access this report"
      });
    }
    
    // Filters
    const city = req.params.city;
    const dateFilter = resolveDateRange(req.query);
    
    // Fetch all clients for the specified city
    const clients = await Client.find({ city: city, ...dateFilter })
      .populate('whoConverted', 'name')
      .select('name contactPerson email priority createdAt whoConverted')
      .sort({ createdAt: 1 });
    
    if (clients.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No clients found for city: ${city}`
      });
    }
    
    const clientIds = clients.map(client => client._id);
    
    // Fetch opportunities related to these clients
    const opportunities = await Opportunity.find({
      client: { $in: clientIds },
      ...dateFilter
    })
    .populate('client', 'name')
    .populate('property', 'name address')
    .select('client property status createdAt')
    .sort({ createdAt: 1 });
    
    // Fetch properties related to these opportunities
    const propertyIds = opportunities.map(opp => opp.property?._id).filter(Boolean);
    const properties = await Property.find({
      _id: { $in: propertyIds }
    }).select('name address');
    
    // Group clients by brand name and count occurrences
    const brandCounts = {};
    
    clients.forEach(client => {
      const brandName = client.name;
      
      if (!brandCounts[brandName]) {
        brandCounts[brandName] = {
          brandName: brandName,
          count: 0,
          totalClients: 0,
          totalOpportunities: 0,
          totalProperties: 0,
          clients: []
        };
      }
      
      brandCounts[brandName].count++;
      brandCounts[brandName].totalClients++;
      
      // Count opportunities for this client
      const clientOpportunities = opportunities.filter(
        opp => opp.client && opp.client._id.toString() === client._id.toString()
      );
      
      brandCounts[brandName].totalOpportunities += clientOpportunities.length;
      
      // Count unique properties for this client
      const uniquePropertyIds = new Set();
      clientOpportunities.forEach(opp => {
        if (opp.property && opp.property._id) {
          uniquePropertyIds.add(opp.property._id.toString());
        }
      });
      
      // Add to total properties count
      brandCounts[brandName].totalProperties += uniquePropertyIds.size;
      
      // Add client details to the brand
      brandCounts[brandName].clients.push({
        clientId: client._id,
        contactPerson: client.contactPerson,
        email: client.email,
        priority: client.priority,
        clientCreationDate: client.createdAt,
        whoConverted: client.whoConverted ? client.whoConverted.name : null,
        opportunitiesCount: clientOpportunities.length,
        opportunities: clientOpportunities.map(opp => ({
          opportunityId: opp._id,
          propertyName: opp.property ? opp.property.name : 'Unknown',
          propertyAddress: opp.property ? opp.property.address : 'Unknown',
          status: opp.status,
          createdAt: opp.createdAt
        }))
      });
    });
    
    // Convert to array for response and sort by count (descending)
    const reportData = Object.values(brandCounts).sort((a, b) => b.count - a.count);
    
    const distinctCities = await Client.distinct('city');
    const distinctBrands = await Client.distinct('name');

    res.status(200).json({
      success: true,
      city: city,
      totalBrands: Object.keys(brandCounts).length,
      totalClients: clients.length,
      totalOpportunities: opportunities.length,
      totalProperties: propertyIds.length,
      data: reportData,
      filters: {
        cities: distinctCities,
        brands: distinctBrands
      }
    });
  } catch (error) {
    console.error("Error generating city-wise report:", error);
    res.status(500).json({
      success: false,
      message: "Error generating city-wise report",
      error: error.message
    });
  }
};

exports.getFePropertyReport = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!["Super Admin", "Manager"].includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You don't have permission to view this report.",
      });
    }

    const dateFilter = resolveDateRange(req.query);

    // Find all properties with their creators (FE-Property users) within the time period
    const properties = await Property.find({ 
      isVisibility: true,
      ...dateFilter
    })
      .populate('whoCreated', 'name role')
      .populate('opportunities')
      .lean();

    // Filter properties created by FE-Property role users
    const feProperties = properties.filter(property => 
      property.whoCreated && property.whoCreated.role === 'FE-Property'
    );

    // Group properties by FE-Property user
    const fePropertyGroups = {};
    
    feProperties.forEach(property => {
      const feId = property.whoCreated._id.toString();
      const feName = property.whoCreated.name;
      
      if (!fePropertyGroups[feId]) {
        fePropertyGroups[feId] = {
          feName: feName,
          totalProperties: 0,
          propertiesWithOpportunities: 0,
          propertiesWithoutOpportunities: 0,
          properties: []
        };
      }
      
      fePropertyGroups[feId].totalProperties += 1;
      
      // Check if property has any opportunities
      const hasOpportunities = property.opportunities && property.opportunities.length > 0;
      
      if (hasOpportunities) {
        fePropertyGroups[feId].propertiesWithOpportunities += 1;
      } else {
        fePropertyGroups[feId].propertiesWithoutOpportunities += 1;
      }
      
      fePropertyGroups[feId].properties.push({
        propertyId: property._id,
        propertyName: property.name,
        address: property.address,
        area: property.area,
        expectedRent: property.expectedRent,
        createdAt: property.createdAt,
        opportunitiesCount: property.opportunities ? property.opportunities.length : 0,
        totalClientsAssigned: Array.isArray(property.linkedClients) ? property.linkedClients.length : 0
      });
    });
    
    const feIds = Object.keys(fePropertyGroups);
    const assignedClientIdsByFe = {};

    feIds.forEach((feId) => {
      const ids = new Set();
      const propertyIds = new Set(
        fePropertyGroups[feId].properties.map((p) => String(p.propertyId))
      );
      feProperties.forEach((property) => {
        if (!propertyIds.has(String(property._id))) return;
        (property.linkedClients || []).forEach((clientId) => {
          const idStr = clientId?._id ? String(clientId._id) : String(clientId);
          if (mongoose.isValidObjectId(idStr)) ids.add(idStr);
        });
      });
      assignedClientIdsByFe[feId] = ids;
    });

    const allAssignedClientIds = [
      ...new Set(feIds.flatMap((feId) => [...assignedClientIdsByFe[feId]])),
    ].filter((id) => mongoose.isValidObjectId(id));

    const opportunityCountByClient = new Map();
    if (allAssignedClientIds.length) {
      const grouped = await Opportunity.aggregate([
        {
          $match: {
            client: {
              $in: allAssignedClientIds.map((id) => new mongoose.Types.ObjectId(id)),
            },
          },
        },
        { $group: { _id: "$client", count: { $sum: 1 } } },
      ]);
      grouped.forEach((row) => {
        opportunityCountByClient.set(String(row._id), row.count);
      });
    }

    const clientDocs = allAssignedClientIds.length
      ? await Client.find({ _id: { $in: allAssignedClientIds } })
          .select("name city")
          .lean()
      : [];
    const clientById = new Map(clientDocs.map((c) => [String(c._id), c]));

    const toClientRow = (id) => {
      const client = clientById.get(id);
      return {
        id,
        name: client?.name || "Unknown client",
        city: client?.city || "",
        opportunityCount: opportunityCountByClient.get(id) || 0,
      };
    };

    const reportData = Object.values(fePropertyGroups).map((group, index) => {
      const feId = feIds[index];
      const assignedIds = [...(assignedClientIdsByFe[feId] || [])];
      const withOpp = [];
      const withoutOpp = [];
      assignedIds.forEach((id) => {
        const row = toClientRow(id);
        if (row.opportunityCount > 0) withOpp.push(row);
        else withoutOpp.push(row);
      });
      withOpp.sort((a, b) => a.name.localeCompare(b.name));
      withoutOpp.sort((a, b) => a.name.localeCompare(b.name));

      return {
        feId,
        feName: group.feName,
        totalProperties: group.totalProperties,
        propertiesWithOpportunities: group.propertiesWithOpportunities,
        propertiesWithoutOpportunities: group.propertiesWithoutOpportunities,
        conversionRate:
          ((group.propertiesWithOpportunities / group.totalProperties) * 100).toFixed(2) + "%",
        totalClientsAssigned: assignedIds.length,
        assignedClientsWithOpportunities: withOpp.length,
        assignedClientsWithoutOpportunities: withoutOpp.length,
        assignedClientsWithOpp: withOpp,
        assignedClientsWithoutOpp: withoutOpp,
        totalOpportunitiesFromAssigned: assignedIds.reduce(
          (sum, id) => sum + (opportunityCountByClient.get(id) || 0),
          0
        ),
      };
    });
    
    // Prepare graph data
    const graphData = {
      labels: reportData.map(item => item.feName),
      datasets: [
        {
          label: 'Total Properties',
          data: reportData.map(item => item.totalProperties),
        },
        {
          label: 'Properties With Opportunities',
          data: reportData.map(item => item.propertiesWithOpportunities),
        },
        {
          label: 'Properties Without Opportunities',
          data: reportData.map(item => item.propertiesWithoutOpportunities),
        }
      ]
    };
    
    // Conversion rate graph data
    const conversionRateGraphData = {
      labels: reportData.map(item => item.feName),
      datasets: [
        {
          label: 'Conversion Rate (%)',
          data: reportData.map(item => parseFloat(item.conversionRate)),
        }
      ]
    };
    
    res.status(200).json({
      success: true,
      period: req.query.period || 'custom',
      totalFePropertyUsers: Object.keys(fePropertyGroups).length,
      totalProperties: feProperties.length,
      data: reportData,
      graphData: graphData,
      conversionRateGraphData: conversionRateGraphData
    });
  } catch (error) {
    console.error("Error generating FE Property report:", error);
    res.status(500).json({
      success: false,
      message: "Error generating FE Property report",
      error: error.message
    });
  }
};

exports.generateSummaryReport = async (req, res) => {
  try {
    // Check user authorization
    const userRole = req.user.role;
    if (!["Super Admin", "Manager", "BO-Client"].includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to access this report"
      });
    }

    // Get time period from query or default to 'all'
    const timePeriod = req.query.period || 'all';
    const dateFilter = resolveDateRange(req.query);
    
    // Get time periods
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const currentQuarter = Math.floor(now.getMonth() / 3);
    const startOfQuarter = new Date(now.getFullYear(), currentQuarter * 3, 1);
    
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    // Set filter date based on time period
    let filterDate = null;
    if (timePeriod === 'week') {
      filterDate = startOfWeek;
    } else if (timePeriod === 'month') {
      filterDate = startOfMonth;
    } else if (timePeriod === 'quarter') {
      filterDate = startOfQuarter;
    } else if (timePeriod === 'year') {
      filterDate = startOfYear;
    }

    // Create query filter based on time period or custom range
    const timeFilter = Object.keys(dateFilter).length ? dateFilter : (filterDate ? { createdAt: { $gte: filterDate } } : {});

    // Fetch counts from each collection with time filter
    const totalLeads = await Lead.countDocuments(timeFilter);
    const totalClients = await Client.countDocuments(timeFilter);
    const totalProperties = await Property.countDocuments(timeFilter);
    
    // Get opportunities and their statuses
    const opportunities = await Opportunity.find(timeFilter).select('status createdAt');
    // Total pipeline = opportunities currently in pipeline statuses
    const pipelineStatuses = [
      "Asking more details of property ( Pictures / Video / Data )",
      "Property Approved but Board Approval Pending",
      "Property is ok - Negotiate Rent",
      "Planning for Site Visit",
      "Looking for Capex Investor",
      "Site-visit-Negative",
      "Site-visit-Positive",
      "One More Visit",
      "LOI",
      "Owner Side Pending",
      "Commercial Details Shared",
      "Find Franchise Investor",
      "Property Approved",
      "Site Visit Done",
      "Loi Received"
    ];
    const totalPipeline = await Opportunity.countDocuments({ ...timeFilter, status: { $in: pipelineStatuses } });
    const totalOpportunities = opportunities.length;
    
    // Count approved and rejected opportunities
    let totalApproved = 0;
    let totalRejected = 0;
    let totalWin = 0;
    
    opportunities.forEach(opp => {
      if (["Approved"].includes(opp.status)) {
        totalApproved++;
      } else if (["Reject"].includes(opp.status)) {
        totalRejected++;
      } else if (["Win"].includes(opp.status)) {
        totalWin++;
      }
    });

    // Prepare graph data for all time periods regardless of filter
    const allOpportunities = await Opportunity.find().select('status createdAt');
    
    // Time period counts
    const weekCounts = { total: 0, approved: 0, rejected: 0, win: 0 };
    const monthCounts = { total: 0, approved: 0, rejected: 0, win: 0 };
    const quarterCounts = { total: 0, approved: 0, rejected: 0, win: 0 };
    const yearCounts = { total: 0, approved: 0, rejected: 0, win: 0 };
    const allTimeCounts = { total: allOpportunities.length, approved: 0, rejected: 0, win: 0 };
    
    allOpportunities.forEach(opp => {
      // Count by status for all time
      if (["Approved"].includes(opp.status)) allTimeCounts.approved++;
      if (["Reject"].includes(opp.status)) allTimeCounts.rejected++;
      if (["Win"].includes(opp.status)) allTimeCounts.win++;
      
      // Time period counts
      const oppDate = new Date(opp.createdAt);
      
      if (oppDate >= startOfWeek) {
        weekCounts.total++;
        if (["Approved"].includes(opp.status)) weekCounts.approved++;
        if (["Reject"].includes(opp.status)) weekCounts.rejected++;
        if (["Win"].includes(opp.status)) weekCounts.win++;
      }
      
      if (oppDate >= startOfMonth) {
        monthCounts.total++;
        if (["Approved"].includes(opp.status)) monthCounts.approved++;
        if (["Reject"].includes(opp.status)) monthCounts.rejected++;
        if (["Win"].includes(opp.status)) monthCounts.win++;
      }
      
      if (oppDate >= startOfQuarter) {
        quarterCounts.total++;
        if (["Approved"].includes(opp.status)) quarterCounts.approved++;
        if (["Reject"].includes(opp.status)) quarterCounts.rejected++;
        if (["Win"].includes(opp.status)) quarterCounts.win++;
      }
      
      if (oppDate >= startOfYear) {
        yearCounts.total++;
        if (["Approved"].includes(opp.status)) yearCounts.approved++;
        if (["Reject"].includes(opp.status)) yearCounts.rejected++;
        if (["Win"].includes(opp.status)) yearCounts.win++;
      }
    });

    const weekLeads = await Lead.countDocuments({ createdAt: { $gte: startOfWeek } });
const monthLeads = await Lead.countDocuments({ createdAt: { $gte: startOfMonth } });
const quarterLeads = await Lead.countDocuments({ createdAt: { $gte: startOfQuarter } });
const yearLeads = await Lead.countDocuments({ createdAt: { $gte: startOfYear } });

const weekClients = await Client.countDocuments({ createdAt: { $gte: startOfWeek } });
const monthClients = await Client.countDocuments({ createdAt: { $gte: startOfMonth } });
const quarterClients = await Client.countDocuments({ createdAt: { $gte: startOfQuarter } });
const yearClients = await Client.countDocuments({ createdAt: { $gte: startOfYear } });

const weekProperties = await Property.countDocuments({ createdAt: { $gte: startOfWeek } });
const monthProperties = await Property.countDocuments({ createdAt: { $gte: startOfMonth } });
const quarterProperties = await Property.countDocuments({ createdAt: { $gte: startOfQuarter } });
const yearProperties = await Property.countDocuments({ createdAt: { $gte: startOfYear } });


    // Prepare graph data
    const timeLabels = ['This Week', 'This Month', 'This Quarter', 'This Year', 'All Time'];
    
    const opportunityGraphData = {
      labels: timeLabels,
      datasets: [
        {
          label: 'Total Leads',
          data: [weekLeads, monthLeads, quarterLeads, yearLeads, totalLeads],
        },
        {
          label: 'Total Clients',
          data: [weekClients, monthClients, quarterClients, yearClients, totalClients],
        },
        {
          label: 'Total Properties',
          data: [weekProperties, monthProperties, quarterProperties, yearProperties, totalProperties],
        },
        
        {
          label: 'Total Opportunities',
          data: [weekCounts.total, monthCounts.total, quarterCounts.total, yearCounts.total, allTimeCounts.total],
        },
        {
          label: 'Approved',
          data: [weekCounts.approved, monthCounts.approved, quarterCounts.approved, yearCounts.approved, allTimeCounts.approved],
        },
        {
          label: 'Rejected',
          data: [weekCounts.rejected, monthCounts.rejected, quarterCounts.rejected, yearCounts.rejected, allTimeCounts.rejected],
        },
        {
          label: 'Won',
          data: [weekCounts.win, monthCounts.win, quarterCounts.win, yearCounts.win, allTimeCounts.win],
        }
      ]
    };
    
    // Prepare leads, clients, properties graph data
    const entityGraphData = {
      labels: ['Leads', 'Clients', 'Properties'],
      datasets: [
        {
          label: 'Total Count',
          data: [totalLeads, totalClients, totalProperties],
        }
      ]
    };

    res.status(200).json({
      success: true,
      period: timePeriod,
      data: {
        totalLeads,
        totalClients,
        totalProperties,
        totalOpportunities,
        totalPipeline,
        totalApproved,
        totalRejected,
        totalWin,
        timePeriods: {
          week: weekCounts,
          month: monthCounts,
          quarter: quarterCounts,
          year: yearCounts,
          all: allTimeCounts
        },
        graphData: opportunityGraphData,
        entityGraphData: entityGraphData
      }
    });
  } catch (error) {
    console.error("Error generating summary report:", error);
    res.status(500).json({
      success: false,
      message: "Error generating summary report",
      error: error.message
    });
  }
};


// Generate Employee Performance Report
exports.generateEmployeePerformanceReport = async (req, res) => {
  try {
    // Check user authorization
    const userRole = req.user.role;
    if (!["Super Admin", "Manager", "BO-Client", "Lead-Employee", "FE-Property", "Product-Manager"].includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to access this report"
      });
    }

    // Get employee ID from query or use logged-in user's ID
    const employeeId = req.query.employeeId || req.user._id;
    
    // Get time period from query or default to 'all'
    const timePeriod = req.query.period || 'all';
    
    // Get time periods
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const currentQuarter = Math.floor(now.getMonth() / 3);
    const startOfQuarter = new Date(now.getFullYear(), currentQuarter * 3, 1);
    
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    // Set filter date based on time period
    let filterDate = null;
    if (timePeriod === 'week') {
      filterDate = startOfWeek;
    } else if (timePeriod === 'month') {
      filterDate = startOfMonth;
    } else if (timePeriod === 'quarter') {
      filterDate = startOfQuarter;
    } else if (timePeriod === 'year') {
      filterDate = startOfYear;
    } else if (timePeriod === 'all') {
      filterDate = null;
    }

    // Create query filter based on time period or custom range
    const dateFilter = resolveDateRange(req.query);
    const timeFilter = Object.keys(dateFilter).length ? dateFilter : (filterDate ? { createdAt: { $gte: filterDate } } : {});
    
    // Combine employee ID with time filter
    const employeeTimeFilter = { ...timeFilter, whoConverted: employeeId };
    const createdByFilter = { ...timeFilter, createdBy: employeeId };
    const assignedToFilter = { ...timeFilter, assignedTo: employeeId };
    const assignedByFilter = { ...timeFilter, assignedBy: employeeId };
    
    let reportData = {};
    let graphData = {};
    
    // Generate report based on user role
    if (userRole === "Lead-Employee") {
      // Leads created
      const leadsCreated = await Lead.countDocuments({ 
        ...createdByFilter
      });
      
      // Leads assigned to this employee by BO-Client
      const leadsAssignedToMe = await Lead.countDocuments({
        ...assignedToFilter
      });
      
      // Clients converted
      const clientsConverted = await Client.countDocuments({
        ...employeeTimeFilter
      });
      
      // Properties assigned to FE-Property
      const propertiesAssigned = await Property.countDocuments({
        ...timeFilter,
        assignedBy: employeeId
      });
      
      // Opportunities linked
      const opportunitiesLinked = await Opportunity.countDocuments({
        ...timeFilter,
        whoLinkthis: employeeId
      });
      
      reportData = {
        leadsCreated,
        leadsAssignedToMe,
        clientsConverted,
        // propertiesAssigned,
        opportunitiesLinked
      };
      
      // Prepare graph data
      graphData = {
        labels: ['Leads Created', 'Leads Assigned To Me', 'Clients Converted',  'Opportunities Linked'],
        datasets: [
          {
            label: 'Performance Metrics',
            data: [leadsCreated, leadsAssignedToMe, clientsConverted,  opportunitiesLinked],
          }
        ]
      };
      
      // Time series data for lead employee
      const timeSeriesData = [];
      for (let i = 0; i < 6; i++) {
        const monthStartDate = new Date(now);
        monthStartDate.setMonth(now.getMonth() - i);
        monthStartDate.setDate(1);
        monthStartDate.setHours(0, 0, 0, 0);
        
        const monthEndDate = new Date(monthStartDate);
        monthEndDate.setMonth(monthStartDate.getMonth() + 1);
        monthEndDate.setDate(0);
        monthEndDate.setHours(23, 59, 59, 999);
        
        const monthFilter = { 
          createdAt: { $gte: monthStartDate, $lte: monthEndDate }
        };
        
        const monthLeadsCreated = await Lead.countDocuments({ 
          ...monthFilter,
          createdBy: employeeId
        });
        
        const monthLeadsAssignedToMe = await Lead.countDocuments({
          ...monthFilter,
          assignedTo: employeeId
        });
        
        const monthClientsConverted = await Client.countDocuments({
          ...monthFilter,
          whoConverted: employeeId
        });
        
        const monthOpportunitiesLinked = await Opportunity.countDocuments({
          ...monthFilter,
          whoLinkthis: employeeId
        });
        
        const monthName = monthStartDate.toLocaleString('default', { month: 'short' });
        const year = monthStartDate.getFullYear();
        
        timeSeriesData.push({
          period: `${monthName} ${year}`,
          leadsCreated: monthLeadsCreated,
          leadsAssignedToMe: monthLeadsAssignedToMe,
          clientsConverted: monthClientsConverted,
          opportunitiesLinked: monthOpportunitiesLinked
        });
      }
      
      // Add time series graph data
      const timeSeriesGraphData = {
        labels: timeSeriesData.map(item => item.period),
        datasets: [
          {
            label: 'Leads Created',
            data: timeSeriesData.map(item => item.leadsCreated),
          },
          {
            label: 'Leads Assigned To Me',
            data: timeSeriesData.map(item => item.leadsAssignedToMe),
          },
          {
            label: 'Clients Converted',
            data: timeSeriesData.map(item => item.clientsConverted),
          },
          {
            label: 'Opportunities Linked',
            data: timeSeriesData.map(item => item.opportunitiesLinked),
          }
        ]
      };
      
      reportData.timeSeriesData = timeSeriesData;
      graphData.timeSeriesGraphData = timeSeriesGraphData;
      
    } else if (userRole === "BO-Client") {
      // Leads created
      const leadsCreated = await Lead.countDocuments({ 
        ...createdByFilter
      });
      
      // Leads assigned to Lead-Employees
      const leadsAssignedToEmployees = await Lead.countDocuments({
        ...assignedByFilter
      });
      
      // Clients converted
      const clientsConverted = await Client.countDocuments({
        ...employeeTimeFilter
      });
      
      // Properties assigned to FE-Property
      const propertiesAssigned = await Property.countDocuments({
        ...timeFilter,
        assignedBy: employeeId
      });
      
      // Opportunities linked
      const opportunitiesLinked = await Opportunity.countDocuments({
        ...timeFilter,
        whoLinkthis: employeeId
      });
      
      reportData = {
        leadsCreated,
        leadsAssignedToEmployees,
        clientsConverted,
        // propertiesAssigned,
        opportunitiesLinked
      };
      
      
      // Prepare graph data
      graphData = {
        labels: ['Leads Created', 'Leads Assigned To Employees', 'Clients Converted',   'Opportunities Linked'],
        datasets: [
          {
            label: 'Performance Metrics',
            data: [leadsCreated, leadsAssignedToEmployees, clientsConverted,   opportunitiesLinked],
          }
        ]
      };
      
      // Time series data for BO client
      const timeSeriesData = [];
      for (let i = 0; i < 6; i++) {
        const monthStartDate = new Date(now);
        monthStartDate.setMonth(now.getMonth() - i);
        monthStartDate.setDate(1);
        monthStartDate.setHours(0, 0, 0, 0);
        
        const monthEndDate = new Date(monthStartDate);
        monthEndDate.setMonth(monthStartDate.getMonth() + 1);
        monthEndDate.setDate(0);
        monthEndDate.setHours(23, 59, 59, 999);
        
        const monthFilter = { 
          createdAt: { $gte: monthStartDate, $lte: monthEndDate }
        };
        
        const monthLeadsCreated = await Lead.countDocuments({ 
          ...monthFilter,
          createdBy: employeeId
        });
        
        const monthLeadsAssignedToEmployees = await Lead.countDocuments({
          ...monthFilter,
          assignedBy: employeeId
        });
        
        const monthClientsConverted = await Client.countDocuments({
          ...monthFilter,
          whoConverted: employeeId
        });
        
        const monthOpportunitiesLinked = await Opportunity.countDocuments({
          ...monthFilter,
          whoLinkthis: employeeId
        });
        
        const monthName = monthStartDate.toLocaleString('default', { month: 'short' });
        const year = monthStartDate.getFullYear();
        
        timeSeriesData.push({
          period: `${monthName} ${year}`,
          leadsCreated: monthLeadsCreated,
          leadsAssignedToEmployees: monthLeadsAssignedToEmployees,
          clientsConverted: monthClientsConverted,
          opportunitiesLinked: monthOpportunitiesLinked
        });
      }
      
      // Add time series graph data
      const timeSeriesGraphData = {
        labels: timeSeriesData.map(item => item.period),
        datasets: [
          {
            label: 'Leads Created',
            data: timeSeriesData.map(item => item.leadsCreated),
          },
          {
            label: 'Leads Assigned To Employees',
            data: timeSeriesData.map(item => item.leadsAssignedToEmployees),
          },
          {
            label: 'Clients Converted',
            data: timeSeriesData.map(item => item.clientsConverted),
          },
          {
            label: 'Opportunities Linked',
            data: timeSeriesData.map(item => item.opportunitiesLinked),
          }
        ]
      };
      
      reportData.timeSeriesData = timeSeriesData;
      graphData.timeSeriesGraphData = timeSeriesGraphData;
      
    } else if (userRole === "FE-Property") {
      // Properties created

      const propertiesCreated = await Property.countDocuments({
        ...timeFilter,
        whoCreated: employeeId
      });
      
      // Properties linked to opportunities
      const propertiesLinked = await Opportunity.countDocuments({
        ...timeFilter,
        property: { $in: await Property.find({ whoCreated: employeeId }).distinct('_id') }
      });
      
      // Clients assigned
      const clientsAssigned = await Client.countDocuments({
        ...timeFilter,
        assignedTo: employeeId
      });
      
      reportData = {
        propertiesCreated,
        propertiesLinked,
        clientsAssigned
      };
      
      // Prepare graph data
      graphData = {
        labels: ['Properties Created', 'Properties Linked', 'Clients Assigned'],
        datasets: [
          {
            label: 'Performance Metrics',
            data: [propertiesCreated, propertiesLinked, clientsAssigned],
          }
        ]
      };
      
      // Time series data for FE property
      const timeSeriesData = [];
      for (let i = 0; i < 6; i++) {
        const monthStartDate = new Date(now);
        monthStartDate.setMonth(now.getMonth() - i);
        monthStartDate.setDate(1);
        monthStartDate.setHours(0, 0, 0, 0);
        
        const monthEndDate = new Date(monthStartDate);
        monthEndDate.setMonth(monthStartDate.getMonth() + 1);
        monthEndDate.setDate(0);
        monthEndDate.setHours(23, 59, 59, 999);
        
        const monthFilter = { 
          createdAt: { $gte: monthStartDate, $lte: monthEndDate }
        };
        
        const monthPropertiesCreated = await Property.countDocuments({
          ...monthFilter,
          whoCreated: employeeId
        });
        
        const monthPropertiesLinked = await Opportunity.countDocuments({
          ...monthFilter,
          property: { $in: await Property.find({ whoCreated: employeeId }).distinct('_id') }
        });
        
        const monthClientsAssigned = await Client.countDocuments({
          ...monthFilter,
          // assignedProperties: { $in: await Property.find({ createdBy: employeeId }).distinct('_id') }
          assignedTo: employeeId
        });
        
        const monthName = monthStartDate.toLocaleString('default', { month: 'short' });
        const year = monthStartDate.getFullYear();
        
        timeSeriesData.push({
          period: `${monthName} ${year}`,
          propertiesCreated: monthPropertiesCreated,
          propertiesLinked: monthPropertiesLinked,
          clientsAssigned: monthClientsAssigned
        });
      }
      
      // Add time series graph data
      const timeSeriesGraphData = {
        labels: timeSeriesData.map(item => item.period),
        datasets: [
          {
            label: 'Properties Created',
            data: timeSeriesData.map(item => item.propertiesCreated),
          },
          {
            label: 'Properties Linked',
            data: timeSeriesData.map(item => item.propertiesLinked),
          },
          {
            label: 'Clients Assigned',
            data: timeSeriesData.map(item => item.clientsAssigned),
          }
        ]
      };
      
      reportData.timeSeriesData = timeSeriesData;
      graphData.timeSeriesGraphData = timeSeriesGraphData;
    }
    
    res.status(200).json({
      success: true,
      period: timePeriod,
      data: reportData,
      graphData: graphData
    });
    
  } catch (error) {
    console.error("Error generating employee performance report:", error);
    res.status(500).json({
      success: false,
      message: "Error generating employee performance report",
      error: error.message
    });
  }
};

// Benchmark days (SLA) per TAT stage — tune for your org; exposed to UI for red/green comparison
const TAT_BENCHMARK_DAYS = {
  leadToClient: 1,
  clientToOpportunity: 2,
  tagDefault: 3
};

// Per-tag overrides (optional); any tag not listed uses tagDefault
const TAT_TAG_BENCHMARK_DAYS = {
  Approved: 5,
  LOI: 10,
  Agreement: 14,
  Win: 21,
  Reject: 7,
  "Planning for Site Visit": 3,
  "Site Visit Done": 7,
  "Site-visit-Positive": 5,
  "Site-visit-Negative": 5
};

// All comment tags from Opportunity schema (for opportunity → tag TAT rows)
const OPPORTUNITY_COMMENT_TAGS = [
  "In Evaluation",
  "Need more details of property (Pictures/video/Data)",
  "Property Approved but Board Approval Pending",
  "Property is ok - Negotiate Rent",
  "Keep this option on Hold",
  "Planning for Site Visit",
  "Site-visit-Positive",
  "Site-visit-Hold",
  "Site-visit-Negative",
  "Site Visit Done - Looks Positive",
  "Already Received from other consultant",
  "Height issue",
  "Frontage issue",
  "Size issue",
  "Rental issue",
  "Not suitable",
  "Looking for Better Option",
  "Hold",
  "One More Visit",
  "Keep on Hold",
  "Keep on hold",
  "Follow Up",
  "Reject",
  "Approved",
  "LOI",
  "Agreement",
  "Pending",
  "Win",
  "Call",
  "Loss",
  "Property No Longer Available",
  "Owner Side Pending",
  "Property approve but owner side pending",
  "Find Franchise Investor",
  "Commercial Details Shared",
  "Asking For Commercial Details",
  "Asking For More Details",
  "Find Investor",
  "Property Approved",
  "Site Visit Done",
  "After So Many Attempts But Not Responding",
  "Loi Received",
  "Loi Singed",
  "Looking for Capex Investor",
  "He will check and revert",
  "Asking more details of property ( Pictures / Video / Data )"
];

function tatDaysBetween(a, b) {
  if (!a || !b) return null;
  const ms = new Date(a).getTime() - new Date(b).getTime();
  if (ms < 0) return null;
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

function avgDays(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((x, y) => x + y, 0) / arr.length);
}

function tagBenchmark(tag) {
  return TAT_TAG_BENCHMARK_DAYS[tag] != null ? TAT_TAG_BENCHMARK_DAYS[tag] : TAT_BENCHMARK_DAYS.tagDefault;
}

/**
 * TAT by individual (Lead-Employee, BO-Client, Manager): lead→client, client→first opportunity,
 * and opportunity→each tag (first comment with that tag). Same auth as other reports.
 */
exports.getTatIndividualReport = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!["Super Admin", "Manager", "BO-Client"].includes(userRole)) {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const dateFilter = resolveDateRange(req.query);
    const convertedDateFilter = resolveConvertedAtRange(req.query);

    const convertedClientIds = await Lead.distinct("convertedTo", {
      convertedTo: { $exists: true, $ne: null }
    });
    const convertedSet = new Set(convertedClientIds.map((id) => String(id)));

    const bounds = buildDateRangeBounds(req.query);
    const leadQuery = bounds
      ? { $or: [{ createdAt: bounds }, { convertedAt: bounds }] }
      : {};

    const [users, leads, clients, opportunities] = await Promise.all([
      User.find({ role: { $in: ["Lead-Employee", "BO-Client", "Manager"] } })
        .select("_id name role")
        .lean(),
      Lead.find(leadQuery)
        .select("assignedTo whoConverted createdAt convertedAt convertedTo isConverted")
        .lean(),
      Client.find(Object.keys(dateFilter).length ? dateFilter : {})
        .select("_id createdAt assignedTo whoConverted")
        .lean(),
      Opportunity.find(Object.keys(dateFilter).length ? dateFilter : {})
        .select("client property createdAt whoLinkthis commentsSection")
        .populate("client", "assignedTo createdAt")
        .lean()
    ]);

    const clientById = new Map(clients.map((c) => [String(c._id), c]));
    const leadByClientId = new Map();
    leads.forEach((lead) => {
      if (lead.convertedTo) leadByClientId.set(String(lead.convertedTo), lead);
    });

    const firstOppByClient = new Map();
    for (const opp of opportunities) {
      const cid = String(opp.client?._id || opp.client);
      if (!cid || cid === "undefined") continue;
      const prev = firstOppByClient.get(cid);
      if (!prev || new Date(opp.createdAt) < new Date(prev.createdAt)) {
        firstOppByClient.set(cid, opp);
      }
    }

    // Precompute first comment per tag per opportunity (for attribution & TAT days)
    const firstTagCommentByOpp = new Map();
    for (const opp of opportunities) {
      const oid = String(opp._id);
      const byTag = new Map();
      if (Array.isArray(opp.commentsSection)) {
        const sorted = [...opp.commentsSection].sort(
          (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
        );
        for (const c of sorted) {
          if (!c?.tag || byTag.has(c.tag)) continue;
          byTag.set(c.tag, {
            createdAt: c.createdAt,
            whoCommented: c.whoCommented ? String(c.whoCommented) : null
          });
        }
      }
      firstTagCommentByOpp.set(oid, byTag);
    }

    const uidStr = (id) => (id ? String(id) : null);

    const conversionInWindow = (lead) => {
      if (!lead.isConverted || !lead.convertedAt) return false;
      const t = new Date(lead.convertedAt);
      const cr = convertedDateFilter.convertedAt;
      if (cr) {
        if (cr.$gte && t < cr.$gte) return false;
        if (cr.$lte && t > cr.$lte) return false;
        return true;
      }
      return true;
    };

    const clientCreatedInWindow = (c) => {
      if (!bounds) return true;
      const t = new Date(c.createdAt);
      return t >= bounds.$gte && t <= bounds.$lte;
    };

    const oppCreatedInWindow = (opp) => {
      if (!bounds) return true;
      const t = new Date(opp.createdAt);
      return t >= bounds.$gte && t <= bounds.$lte;
    };

    const tagAggByUser = new Map();
    const ensureTagAgg = (uidS) => {
      if (!tagAggByUser.has(uidS)) tagAggByUser.set(uidS, new Map());
      return tagAggByUser.get(uidS);
    };

    for (const opp of opportunities) {
      if (!oppCreatedInWindow(opp)) continue;
      const byTag = firstTagCommentByOpp.get(String(opp._id));
      if (!byTag || !byTag.size) continue;
      const assigned = uidStr(opp.client?.assignedTo);
      const linker = uidStr(opp.whoLinkthis);
      const portfolioUsers = new Set([assigned, linker].filter(Boolean));

      for (const [tag, first] of byTag) {
        if (!first) continue;
        for (const uidS of portfolioUsers) {
          const agg = ensureTagAgg(uidS);
          if (!agg.has(tag)) agg.set(tag, { portfolio: 0, workDone: 0, days: [] });
          const row = agg.get(tag);
          row.portfolio++;
          const commenter = first.whoCommented ? String(first.whoCommented) : null;
          if (commenter === uidS) {
            row.workDone++;
            const d = tatDaysBetween(first.createdAt, opp.createdAt);
            if (d != null) row.days.push(d);
          }
        }
      }
    }

    const buildMetricsForUser = (uid) => {
      const uidS = String(uid);

      // —— Lead → Client ——
      let leadAssignedInPeriod = 0;
      for (const lead of leads) {
        if (uidStr(lead.assignedTo) !== uidS || !lead.createdAt) continue;
        if (bounds && (new Date(lead.createdAt) < bounds.$gte || new Date(lead.createdAt) > bounds.$lte)) continue;
        leadAssignedInPeriod++;
      }
      let directClientsCreated = 0;
      for (const c of clients) {
        if (uidStr(c.whoConverted) !== uidS) continue;
        if (convertedSet.has(String(c._id))) continue;
        if (!clientCreatedInWindow(c)) continue;
        directClientsCreated++;
      }

      const leadToClientDays = [];
      let leadConversions = 0;
      for (const lead of leads) {
        if (!lead.isConverted || uidStr(lead.whoConverted) !== uidS) continue;
        if (!conversionInWindow(lead)) continue;
        const client = lead.convertedTo ? clientById.get(String(lead.convertedTo)) : null;
        if (client) {
          const d = tatDaysBetween(client.createdAt, lead.createdAt);
          if (d != null) leadToClientDays.push(d);
        }
        leadConversions++;
      }
      for (const c of clients) {
        if (uidStr(c.whoConverted) !== uidS) continue;
        if (convertedSet.has(String(c._id))) continue;
        if (!clientCreatedInWindow(c)) continue;
        leadToClientDays.push(1);
      }

      const totalTasksLead = leadAssignedInPeriod + directClientsCreated;
      const workDoneLead = leadConversions + directClientsCreated;
      const avgLead = avgDays(leadToClientDays);
      const benchLead = TAT_BENCHMARK_DAYS.leadToClient;

      // —— Client → first Opportunity (property link) ——
      let clientsAssigned = 0;
      for (const c of clients) {
        if (uidStr(c.assignedTo) !== uidS) continue;
        if (!clientCreatedInWindow(c)) continue;
        clientsAssigned++;
      }

      const clientToOppDays = [];
      let clientToOppDone = 0;
      firstOppByClient.forEach((firstOpp, clientId) => {
        if (uidStr(firstOpp.whoLinkthis) !== uidS) return;
        const c = clientById.get(clientId);
        if (!c) return;
        if (!oppCreatedInWindow(firstOpp)) return;
        const d = tatDaysBetween(firstOpp.createdAt, c.createdAt);
        if (d != null) clientToOppDays.push(d);
        clientToOppDone++;
      });

      const benchClientOpp = TAT_BENCHMARK_DAYS.clientToOpportunity;
      const avgClientOpp = avgDays(clientToOppDays);

      // —— Opportunity → each tag (pre-aggregated in tagAggByUser) ——
      const userTagMap = tagAggByUser.get(uidS) || new Map();
      const tagRows = [];
      for (const tag of OPPORTUNITY_COMMENT_TAGS) {
        const row = userTagMap.get(tag);
        const portfolioReachedTag = row?.portfolio ?? 0;
        const firstByThisUser = row?.workDone ?? 0;
        const avgTag = avgDays(row?.days || []);
        const benchT = tagBenchmark(tag);
        tagRows.push({
          key: `tag:${tag}`,
          kind: "opportunityToTag",
          tag,
          label: `Opportunity → ${tag}`,
          totalTasks: portfolioReachedTag,
          workDone: firstByThisUser,
          conversionRatio:
            portfolioReachedTag > 0
              ? Math.round((firstByThisUser / portfolioReachedTag) * 1000) / 10
              : null,
          averageDays: avgTag,
          benchmarkDays: benchT,
          exceedsBenchmark: avgTag != null && avgTag > benchT
        });
      }

      return {
        leadToClient: {
          key: "leadToClient",
          kind: "leadToClient",
          label: "Lead → Client (convert)",
          totalTasks: totalTasksLead,
          workDone: workDoneLead,
          conversionRatio:
            totalTasksLead > 0 ? Math.round((workDoneLead / totalTasksLead) * 1000) / 10 : null,
          averageDays: avgLead,
          benchmarkDays: benchLead,
          exceedsBenchmark: avgLead != null && avgLead > benchLead
        },
        clientToOpportunity: {
          key: "clientToOpportunity",
          kind: "clientToOpportunity",
          label: "Client → Opportunity (first property link)",
          totalTasks: clientsAssigned,
          workDone: clientToOppDone,
          conversionRatio:
            clientsAssigned > 0 ? Math.round((clientToOppDone / clientsAssigned) * 1000) / 10 : null,
          averageDays: avgClientOpp,
          benchmarkDays: benchClientOpp,
          exceedsBenchmark: avgClientOpp != null && avgClientOpp > benchClientOpp
        },
        tags: tagRows
      };
    };

    const roleOrder = { "Lead-Employee": 0, "BO-Client": 1, Manager: 2 };
    const individuals = users
      .map((u) => {
        const m = buildMetricsForUser(u._id);
        return {
          userId: u._id,
          name: u.name,
          role: u.role,
          metrics: [m.leadToClient, m.clientToOpportunity, ...m.tags]
        };
      })
      .sort((a, b) => {
        const ra = roleOrder[a.role] ?? 99;
        const rb = roleOrder[b.role] ?? 99;
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name);
      });

    res.status(200).json({
      success: true,
      period: req.query.period || "custom",
      benchmarks: {
        leadToClient: TAT_BENCHMARK_DAYS.leadToClient,
        clientToOpportunity: TAT_BENCHMARK_DAYS.clientToOpportunity,
        tagDefault: TAT_BENCHMARK_DAYS.tagDefault,
        tagOverrides: TAT_TAG_BENCHMARK_DAYS
      },
      individuals
    });
  } catch (error) {
    console.error("Error generating individual TAT report:", error);
    res.status(500).json({
      success: false,
      message: "Error generating individual TAT report",
      error: error.message
    });
  }
};

const ADMIN_FUNNEL_ROLES = [
  "Lead-Employee",
  "BO-Client",
  "Manager",
  "Super Admin"
];

function adminFunnelRatio(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function adminFunnelDateInBounds(value, bounds) {
  if (!bounds) return true;
  if (!value) return false;
  const t = new Date(value);
  if (bounds.$gte && t < bounds.$gte) return false;
  if (bounds.$lte && t > bounds.$lte) return false;
  return true;
}

function adminFunnelConvertedInWindow(lead, convertedBounds) {
  if (!lead?.isConverted || !lead?.whoConverted) return false;
  const at = lead.convertedAt;
  if (!convertedBounds?.convertedAt) return true;
  if (!at) return false;
  const t = new Date(at);
  const cr = convertedBounds.convertedAt;
  if (cr.$gte && t < cr.$gte) return false;
  if (cr.$lte && t > cr.$lte) return false;
  return true;
}

function adminFunnelBuildSteps({
  leadsGenerated,
  leadsConverted,
  totalClients,
  totalOpportunityCount,
  oppMetrics
}) {
  const {
    totalOpportunities,
    opportunityToPipeline,
    opportunityToSiteVisitDone,
    siteVisitDoneCount,
    siteVisitDoneToLoi,
    loiSignCount,
    loiToAgreement
  } = oppMetrics;

  return [
    {
      key: "leadGenerated",
      label: "Lead Generated",
      count: leadsGenerated,
      ratio: null,
      baseCount: null,
      baseLabel: null
    },
    {
      key: "leadToClient",
      label: "Lead to Client (new only)",
      count: leadsConverted,
      baseCount: leadsGenerated,
      baseLabel: "Leads",
      ratio: adminFunnelRatio(leadsConverted, leadsGenerated)
    },
    {
      key: "clientToOpportunity",
      label: "Client to Opportunity",
      count: totalOpportunityCount,
      baseCount: totalClients,
      baseLabel: "Clients",
      ratio: adminFunnelRatio(totalOpportunityCount, totalClients)
    },
    {
      key: "opportunityToPipeline",
      label: "Opportunity to Pipeline",
      count: opportunityToPipeline,
      baseCount: totalOpportunities,
      baseLabel: "Opportunities",
      ratio: adminFunnelRatio(opportunityToPipeline, totalOpportunities)
    },
    {
      key: "opportunityToSiteVisitDone",
      label: "Opportunity to Site Visit Done",
      count: opportunityToSiteVisitDone,
      baseCount: totalOpportunities,
      baseLabel: "Opportunities",
      ratio: adminFunnelRatio(opportunityToSiteVisitDone, totalOpportunities)
    },
    {
      key: "siteVisitDoneToLoi",
      label: "Site Visit Done to LOI Sign",
      count: siteVisitDoneToLoi,
      baseCount: siteVisitDoneCount,
      baseLabel: "Site Visit Done",
      ratio: adminFunnelRatio(siteVisitDoneToLoi, siteVisitDoneCount)
    },
    {
      key: "loiToAgreement",
      label: "LOI Sign to Agreement",
      count: loiToAgreement,
      baseCount: loiSignCount,
      baseLabel: "LOI Sign",
      ratio: adminFunnelRatio(loiToAgreement, loiSignCount)
    }
  ];
}

function adminFunnelClientAttributedToUser(client, uidS, role) {
  if (role === "Lead-Employee") {
    return client.assignedTo && String(client.assignedTo) === uidS;
  }
  return client.whoConverted && String(client.whoConverted) === uidS;
}

function adminFunnelComputeForUser(uid, role, leads, clients, opportunities, bounds, convertedBounds) {
  const uidS = String(uid);

  let leadsGenerated = 0;
  let leadsConverted = 0;
  for (const lead of leads) {
    if (String(lead.createdBy) === uidS && adminFunnelDateInBounds(lead.createdAt, bounds)) {
      leadsGenerated += 1;
    }
    if (
      String(lead.whoConverted) === uidS &&
      adminFunnelConvertedInWindow(lead, convertedBounds)
    ) {
      leadsConverted += 1;
    }
  }

  let totalClients = 0;
  for (const client of clients) {
    if (!adminFunnelClientAttributedToUser(client, uidS, role)) continue;
    if (!adminFunnelDateInBounds(client.createdAt, bounds)) continue;
    totalClients += 1;
  }

  const userOpportunities = opportunities.filter((opp) => {
    if (!opp.whoLinkthis || String(opp.whoLinkthis) !== uidS) return false;
    return adminFunnelDateInBounds(opp.createdAt, bounds);
  });

  const oppMetrics = countOpportunityStages(userOpportunities);
  return adminFunnelBuildSteps({
    leadsGenerated,
    leadsConverted,
    totalClients,
    totalOpportunityCount: userOpportunities.length,
    oppMetrics
  });
}

function adminFunnelComputeCompany(leads, clients, opportunities, bounds, convertedBounds) {
  let leadsGenerated = 0;
  let leadsConverted = 0;
  for (const lead of leads) {
    if (adminFunnelDateInBounds(lead.createdAt, bounds)) leadsGenerated += 1;
    if (adminFunnelConvertedInWindow(lead, convertedBounds)) leadsConverted += 1;
  }

  let totalClients = 0;
  for (const client of clients) {
    if (!adminFunnelDateInBounds(client.createdAt, bounds)) continue;
    totalClients += 1;
  }

  // Match dashboard /api/count — all opportunities in period (same set as pipeline steps)
  const companyOpps = opportunities.filter((opp) =>
    adminFunnelDateInBounds(opp.createdAt, bounds)
  );

  const oppMetrics = countOpportunityStages(companyOpps);
  return adminFunnelBuildSteps({
    leadsGenerated,
    leadsConverted,
    totalClients,
    totalOpportunityCount: companyOpps.length,
    oppMetrics
  });
}

exports.getAdminDashboardFunnel = async (req, res) => {
  try {
    if (req.user.role !== "Super Admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Super Admin only."
      });
    }

    const bounds = buildDateRangeBounds(req.query);
    const convertedBounds = toConvertedBounds(bounds);
    let compareBounds = buildCompareDateRangeBounds(req.query);

    // Preset periods: auto-compare to the immediately previous equal-length window
    // unless the client sent an explicit compare range (custom dual dates).
    const periodKey =
      req.query.startDate || req.query.endDate
        ? "custom"
        : req.query.period || "all";
    if (
      !compareBounds &&
      bounds &&
      periodKey !== "all" &&
      periodKey !== "custom"
    ) {
      compareBounds = buildPreviousEqualBounds(bounds);
    }

    const filterEmployeeId = req.query.employeeId
      ? String(req.query.employeeId)
      : null;
    const filterRole = req.query.role || null;

    const fetchBounds = mergeDateBounds(bounds, compareBounds);
    const leadQuery = fetchBounds
      ? { $or: [{ createdAt: fetchBounds }, { convertedAt: fetchBounds }] }
      : {};
    const clientQuery = fetchBounds ? { createdAt: fetchBounds } : {};
    const oppQuery = fetchBounds ? { createdAt: fetchBounds } : {};

    const [users, leads, clients, opportunities] = await Promise.all([
      User.find({ role: { $in: ADMIN_FUNNEL_ROLES } })
        .select("_id name role")
        .lean(),
      Lead.find(leadQuery)
        .select("createdBy whoConverted isConverted convertedAt createdAt convertedTo")
        .lean(),
      Client.find(clientQuery)
        .select("_id createdAt assignedTo whoConverted opportunities isVisibility")
        .lean(),
      Opportunity.find(oppQuery)
        .select(
          "createdAt isVisibility whoLinkthis status commentsSection loaDetails agreementDetails"
        )
        .lean()
    ]);

    const funnel = adminFunnelComputeCompany(
      leads,
      clients,
      opportunities,
      bounds,
      convertedBounds
    );

    const compareConvertedBounds = toConvertedBounds(compareBounds);
    const previousFunnel = compareBounds
      ? adminFunnelComputeCompany(
          leads,
          clients,
          opportunities,
          compareBounds,
          compareConvertedBounds
        )
      : null;

    const comparison =
      previousFunnel && compareBounds
        ? buildFunnelComparisonPayload(
            funnel,
            previousFunnel,
            formatBoundsLabel(bounds),
            formatBoundsLabel(compareBounds)
          )
        : null;

    const byRole = {};
    for (const role of ADMIN_FUNNEL_ROLES) {
      byRole[role] = [];
    }

    for (const user of users) {
      if (filterRole && user.role !== filterRole) continue;
      if (filterEmployeeId && String(user._id) !== filterEmployeeId) continue;

      const userFunnel = adminFunnelComputeForUser(
        user._id,
        user.role,
        leads,
        clients,
        opportunities,
        bounds,
        convertedBounds
      );

      const row = {
        userId: user._id,
        name: user.name,
        role: user.role,
        funnel: userFunnel,
      };

      if (previousFunnel && compareBounds) {
        const userPrevious = adminFunnelComputeForUser(
          user._id,
          user.role,
          leads,
          clients,
          opportunities,
          compareBounds,
          compareConvertedBounds
        );
        row.comparison = buildFunnelComparisonPayload(
          userFunnel,
          userPrevious,
          formatBoundsLabel(bounds),
          formatBoundsLabel(compareBounds)
        );
      }

      if (byRole[user.role]) {
        byRole[user.role].push(row);
      }
    }

    for (const role of ADMIN_FUNNEL_ROLES) {
      byRole[role].sort((a, b) => {
        const aLead = a.funnel.find((s) => s.key === "leadGenerated")?.count || 0;
        const bLead = b.funnel.find((s) => s.key === "leadGenerated")?.count || 0;
        if (bLead !== aLead) return bLead - aLead;
        const aConv = a.funnel.find((s) => s.key === "leadToClient")?.count || 0;
        const bConv = b.funnel.find((s) => s.key === "leadToClient")?.count || 0;
        return bConv - aConv;
      });
    }

    let selectedEmployee = null;
    if (filterEmployeeId) {
      const match = users.find((u) => String(u._id) === filterEmployeeId);
      if (match) {
        const empFunnel = adminFunnelComputeForUser(
          match._id,
          match.role,
          leads,
          clients,
          opportunities,
          bounds,
          convertedBounds
        );
        selectedEmployee = {
          userId: match._id,
          name: match.name,
          role: match.role,
          funnel: empFunnel,
        };
        if (previousFunnel && compareBounds) {
          selectedEmployee.comparison = buildFunnelComparisonPayload(
            empFunnel,
            adminFunnelComputeForUser(
              match._id,
              match.role,
              leads,
              clients,
              opportunities,
              compareBounds,
              compareConvertedBounds
            ),
            formatBoundsLabel(bounds),
            formatBoundsLabel(compareBounds)
          );
        }
      }
    }

    res.status(200).json({
      success: true,
      period: periodKey,
      funnel,
      comparison,
      byRole,
      selectedEmployee,
      attribution: {
        leadGenerated: "Lead.createdBy in period",
        leadToClient: "Lead.whoConverted + convertedAt in period (excludes copy/direct clients)",
        clientToOpportunity:
          "Total opportunities ÷ total clients (same opportunity count as dashboard; ratio base is clients)",
        opportunityToPipeline:
          "Same as Pipeline page: isVisibility true and current status in pipeline list (7 statuses)",
        opportunityToSiteVisitDone:
          "Comment tag Site Visit Done (list filter) or current status Site Visit Done / Looks Positive",
        siteVisitDoneToLoi:
          "Opportunities that reached site visit done and also reached LOI (subset of site visit count)",
        loiToAgreement:
          "Opportunities that reached LOI (status, LOA details, or LOI comment) and also agreement",
        opportunityStages: "Opportunity.whoLinkthis — opportunities created in period"
      }
    });
  } catch (error) {
    console.error("Error generating admin dashboard funnel:", error);
    res.status(500).json({
      success: false,
      message: "Error generating admin dashboard funnel",
      error: error.message
    });
  }
};


