/**
 * Lifecycle chain analytics aligned with CRM workflow:
 *   Lead → Client → Property link → Opportunity
 * Uses entity relationships + audit logs (same rules as auditRecordHistoryService).
 */

const mongoose = require("mongoose");
const Lead = require("../../models/Lead");
const Client = require("../../models/Client");
const Opportunity = require("../../models/Opportunity");
const Property = require("../../models/propertyModel");
const AuditLog = require("../../models/AuditLog");
const { ALLOWED_RESOURCES } = require("../auditRecordHistoryService");
const { safeRatio } = require("./periodUtils");

const STUCK_DAYS = parseInt(process.env.INSIGHTS_STUCK_DAYS || "7", 10);

/** Match record history — exclude noisy middleware duplicates. */
const AUDIT_QUALITY_MATCH = {
  "details.source": { $ne: "api_middleware" },
};

const LIFECYCLE_RESOURCES = ["Lead", "Client", "Property", "Opportunity"];

function auditPeriodMatch(start, end) {
  return {
    ...AUDIT_QUALITY_MATCH,
    createdAt: { $gte: start, $lte: end },
    resource: { $in: LIFECYCLE_RESOURCES },
    action: { $in: ["data_create", "data_update", "admin_action", "data_delete"] },
  };
}

/**
 * Linked funnel: counts at each stage and conversion rates between stages.
 */
async function getLifecycleChain(start, end) {
  const leadsCreated = await Lead.countDocuments({
    createdAt: { $gte: start, $lte: end },
  });

  const convertedLeads = await Lead.find({
    isConverted: true,
    convertedAt: { $gte: start, $lte: end },
  })
    .select("convertedTo convertedAt")
    .lean();

  const leadsConverted = convertedLeads.length;
  const clientIdsFromLeads = [
    ...new Set(convertedLeads.map((l) => l.convertedTo).filter(Boolean).map(String)),
  ];

  const clientsCreated = await Client.countDocuments({
    createdAt: { $gte: start, $lte: end },
  });

  let clientsWithPropertyLink = 0;
  let clientsWithOpportunity = 0;

  if (clientIdsFromLeads.length) {
    const cohortClients = await Client.find({
      _id: { $in: clientIdsFromLeads },
    })
      .select("linkedProperties opportunities")
      .lean();

    for (const c of cohortClients) {
      if (c.linkedProperties?.length) clientsWithPropertyLink += 1;
      if (c.opportunities?.length) clientsWithOpportunity += 1;
    }
  }

  const propertiesCreated = await Property.countDocuments({
    createdAt: { $gte: start, $lte: end },
  });

  const opportunitiesCreated = await Opportunity.countDocuments({
    createdAt: { $gte: start, $lte: end },
  });

  const [linkEventsAudit, conversionEventsAudit] = await Promise.all([
    AuditLog.countDocuments({
      ...auditPeriodMatch(start, end),
      "details.action": "link_property_create_opportunity",
    }),
    AuditLog.countDocuments({
      ...auditPeriodMatch(start, end),
      $or: [
        { "details.action": "convert_to_client" },
        { "details.action": "from_lead_conversion" },
      ],
    }),
  ]);

  const propertyLinksInPeriod = await Client.countDocuments({
    updatedAt: { $gte: start, $lte: end },
    linkedProperties: { $exists: true, $ne: [] },
  });

  return {
    steps: [
      {
        key: "lead_created",
        label: "Leads created",
        count: leadsCreated,
        resource: "Lead",
      },
      {
        key: "lead_to_client",
        label: "Lead → Client",
        count: leadsConverted,
        baseCount: leadsCreated,
        rate: safeRatio(leadsConverted, leadsCreated),
        resource: "Client",
      },
      {
        key: "client_to_property",
        label: "Converted clients with property link",
        count: clientsWithPropertyLink,
        baseCount: leadsConverted,
        rate: safeRatio(clientsWithPropertyLink, leadsConverted),
        resource: "Property",
      },
      {
        key: "client_to_opportunity",
        label: "Converted clients with opportunity",
        count: clientsWithOpportunity,
        baseCount: leadsConverted,
        rate: safeRatio(clientsWithOpportunity, leadsConverted),
        resource: "Opportunity",
      },
      {
        key: "properties_added",
        label: "Properties added",
        count: propertiesCreated,
        resource: "Property",
      },
      {
        key: "opportunities_created",
        label: "Opportunities created (link)",
        count: opportunitiesCreated,
        auditLinkEvents: linkEventsAudit,
        resource: "Opportunity",
      },
    ],
    cohort: {
      leadsConverted,
      clientsWithPropertyLink,
      clientsWithOpportunity,
      leadToClientRate: safeRatio(leadsConverted, leadsCreated),
      clientToPropertyRate: safeRatio(clientsWithPropertyLink, leadsConverted),
      clientToOpportunityRate: safeRatio(clientsWithOpportunity, leadsConverted),
      endToEndRate: safeRatio(clientsWithOpportunity, leadsCreated),
    },
    totals: {
      clientsCreated,
      propertiesCreated,
      opportunitiesCreated,
      propertyLinksInPeriod,
      auditConversionEvents: conversionEventsAudit,
      auditLinkEvents: linkEventsAudit,
    },
  };
}

/**
 * Clients stuck before property link or opportunity after conversion.
 * backlog = all converted clients company-wide (not limited to report period).
 */
async function getLifecycleDropoffs(asOfDate, periodStart, periodEnd) {
  const cutoff = new Date(asOfDate.getTime() - STUCK_DAYS * 24 * 60 * 60 * 1000);

  const staleConvertedLeads = await Lead.find({
    isConverted: true,
    convertedAt: { $lt: cutoff },
    convertedTo: { $ne: null },
  })
    .select("convertedTo convertedAt name")
    .populate("convertedTo", "name linkedProperties opportunities createdAt")
    .lean();

  let clientsNoProperty = 0;
  let clientsNoOpportunity = 0;
  const examples = [];

  for (const lead of staleConvertedLeads) {
    const client = lead.convertedTo;
    if (!client || typeof client !== "object") continue;

    const daysSinceConvert = Math.ceil(
      (asOfDate - new Date(lead.convertedAt)) / (24 * 60 * 60 * 1000)
    );
    const hasProps = client.linkedProperties?.length > 0;
    const hasOpps = client.opportunities?.length > 0;

    if (!hasProps) {
      clientsNoProperty += 1;
      if (examples.length < 8) {
        examples.push({
          type: "client_no_property",
          leadName: lead.name,
          clientName: client.name,
          daysSinceConvert,
          message: "Converted to client but no property linked yet",
        });
      }
    } else if (!hasOpps) {
      clientsNoOpportunity += 1;
      if (examples.length < 8) {
        examples.push({
          type: "client_no_opportunity",
          clientName: client.name,
          daysSinceConvert,
          propertyCount: client.linkedProperties.length,
          message: "Property linked but no opportunity on record",
        });
      }
    }
  }

  let periodLeadsConverted = 0;
  let periodStillNoProperty = 0;
  let periodStillNoOpportunity = 0;

  if (periodStart && periodEnd) {
    const periodConverted = await Lead.find({
      isConverted: true,
      convertedAt: { $gte: periodStart, $lte: periodEnd },
      convertedTo: { $ne: null },
    })
      .select("convertedTo convertedAt name")
      .populate("convertedTo", "name linkedProperties opportunities")
      .lean();

    periodLeadsConverted = periodConverted.length;

    for (const lead of periodConverted) {
      const client = lead.convertedTo;
      if (!client || typeof client !== "object") continue;
      const hasProps = client.linkedProperties?.length > 0;
      const hasOpps = client.opportunities?.length > 0;
      if (!hasProps) periodStillNoProperty += 1;
      else if (!hasOpps) periodStillNoOpportunity += 1;
    }
  }

  return {
    thresholdDays: STUCK_DAYS,
    scopeLabel: "Company-wide backlog (all converted clients, not just this period)",
    clientsNoPropertyAfterConvert: clientsNoProperty,
    clientsNoOpportunityAfterLink: clientsNoOpportunity,
    period: {
      leadsConverted: periodLeadsConverted,
      stillNoProperty: periodStillNoProperty,
      stillNoOpportunity: periodStillNoOpportunity,
    },
    examples,
  };
}

/**
 * Audit activity on lifecycle entities (excludes api_middleware).
 */
async function getAuditLifecycleActivity(start, end) {
  const base = auditPeriodMatch(start, end);

  const [byResourceAgg, linkEvents, conversionEvents, fieldChanges, totalEvents] =
    await Promise.all([
      AuditLog.aggregate([
        { $match: base },
        { $group: { _id: "$resource", count: { $sum: 1 } } },
      ]),
      AuditLog.countDocuments({
        ...base,
        "details.action": "link_property_create_opportunity",
      }),
      AuditLog.countDocuments({
        ...base,
        $or: [
          { "details.action": "convert_to_client" },
          { "details.action": "from_lead_conversion" },
        ],
      }),
      AuditLog.countDocuments({
        ...base,
        "details.changeType": "field_change",
      }),
      AuditLog.countDocuments(base),
    ]);

  const byResource = {};
  for (const r of LIFECYCLE_RESOURCES) byResource[r] = 0;
  for (const row of byResourceAgg) {
    if (row._id) byResource[row._id] = row.count;
  }

  const byUserAgg = await AuditLog.aggregate([
    { $match: base },
    { $group: { _id: "$userId", count: { $sum: 1 }, email: { $first: "$userEmail" } } },
    { $sort: { count: -1 } },
    { $limit: 15 },
  ]);

  return {
    totalEvents,
    byResource,
    linkPropertyEvents: linkEvents,
    leadConversionEvents: conversionEvents,
    fieldChanges,
    topUsers: byUserAgg.map((u) => ({
      userId: u._id,
      email: u.email,
      eventCount: u.count,
    })),
    excludesMiddleware: true,
  };
}

/**
 * First response time from audit: assignment → first meaningful lead update in audit history.
 */
async function getResponseTimeFromAudit(start, end) {
  const leads = await Lead.find({
    whenassign: { $gte: start, $lte: end },
    assignedTo: { $ne: null },
  })
    .select("whenassign _id")
    .lean();

  if (!leads.length) return { avgHours: null, sampleSize: 0, source: "audit" };

  const hours = [];

  for (const lead of leads) {
    if (!lead.whenassign) continue;
    const assignTime = new Date(lead.whenassign);
    const id = lead._id;

    const firstTouch = await AuditLog.findOne({
      ...AUDIT_QUALITY_MATCH,
      resource: "Lead",
      resourceId: id,
      createdAt: { $gte: assignTime, $lte: end },
      action: { $in: ["data_update", "admin_action"] },
    })
      .sort({ createdAt: 1 })
      .select("createdAt")
      .lean();

    if (!firstTouch?.createdAt) continue;

    const h = (new Date(firstTouch.createdAt) - assignTime) / (1000 * 60 * 60);
    if (h >= 0 && h < 720) hours.push(h);
  }

  if (!hours.length) return { avgHours: null, sampleSize: 0, source: "audit" };

  return {
    avgHours: Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10,
    sampleSize: hours.length,
    source: "audit",
  };
}

/**
 * Record-level history event count for a resource (uses auditRecordHistoryService rules).
 */
async function countLinkedAuditEvents(resource, resourceId, start, end) {
  if (!ALLOWED_RESOURCES.has(resource) || !mongoose.isValidObjectId(resourceId)) {
    return 0;
  }

  const id = new mongoose.Types.ObjectId(resourceId);
  const idStr = String(resourceId);

  const or = [
    { resourceId: id },
    { "details.leadId": idStr },
    { "details.clientId": idStr },
    { "details.propertyId": idStr },
  ];

  if (resource === "Client") {
    const oppIds = await Opportunity.find({ client: id }).distinct("_id");
    if (oppIds.length) {
      or.push({ resource: "Opportunity", resourceId: { $in: oppIds } });
    }
  }

  if (resource === "Property") {
    const oppIds = await Opportunity.find({ property: id }).distinct("_id");
    if (oppIds.length) {
      or.push({ resource: "Opportunity", resourceId: { $in: oppIds } });
    }
  }

  return AuditLog.countDocuments({
    $or: or,
    ...AUDIT_QUALITY_MATCH,
    createdAt: { $gte: start, $lte: end },
  });
}

async function buildLifecycleSnapshot(start, end, asOfDate) {
  const [chain, dropoffs, auditActivity, responseAudit] = await Promise.all([
    getLifecycleChain(start, end),
    getLifecycleDropoffs(asOfDate, start, end),
    getAuditLifecycleActivity(start, end),
    getResponseTimeFromAudit(start, end),
  ]);

  return {
    chain,
    dropoffs,
    auditActivity,
    responseTimeAudit: responseAudit,
  };
}

module.exports = {
  getLifecycleChain,
  getLifecycleDropoffs,
  getAuditLifecycleActivity,
  getResponseTimeFromAudit,
  buildLifecycleSnapshot,
  AUDIT_QUALITY_MATCH,
  STUCK_DAYS,
};
