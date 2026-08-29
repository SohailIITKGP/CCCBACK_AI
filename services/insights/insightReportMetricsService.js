/**
 * Bridges CRM reportController metrics into AI Insights (same math, period-aligned).
 */
const Lead = require("../../models/Lead");
const Client = require("../../models/Client");
const Opportunity = require("../../models/Opportunity");
const Property = require("../../models/propertyModel");
const User = require("../../models/User");
const { PIPELINE_STATUSES } = require("../../utils/opportunityPipelineList");
const { computeCompanyFunnelForPeriod } = require("../../utils/adminFunnelMetrics");
const { TAT_BENCHMARK_DAYS, tagBenchmarkDays } = require("../../constants/tatBenchmarks");

const PIPELINE_STATUS_SET = new Set(PIPELINE_STATUSES);

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

async function computeCompanyTat(start, end) {
  const dateFilter = { createdAt: { $gte: start, $lte: end } };

  const [leads, clients, opportunities] = await Promise.all([
    Lead.find(dateFilter).select("_id createdAt convertedAt convertedTo").lean(),
    Client.find(dateFilter).select("_id createdAt").lean(),
    Opportunity.find(dateFilter)
      .select("_id client createdAt commentsSection loaDetails agreementDetails")
      .lean(),
  ]);

  const leadByClientId = new Map();
  for (const lead of leads) {
    if (lead.convertedTo) leadByClientId.set(String(lead.convertedTo), lead);
  }
  const clientById = new Map(clients.map((c) => [String(c._id), c]));

  const firstOppByClient = new Map();
  for (const opp of opportunities) {
    const cid = String(opp.client);
    const prev = firstOppByClient.get(cid);
    if (!prev || new Date(opp.createdAt) < new Date(prev.createdAt)) {
      firstOppByClient.set(cid, opp);
    }
  }

  const accum = {
    leadToClient: [],
    clientToOpportunity: [],
    opportunityToPipeline: [],
    opportunityToSiteVisit: [],
    siteVisitToLoi: [],
    loiToAgreement: [],
  };

  for (const client of clients) {
    const lead = leadByClientId.get(String(client._id));
    if (lead) {
      const d = tatDaysBetween(client.createdAt, lead.createdAt);
      if (d != null) accum.leadToClient.push(d);
    } else {
      accum.leadToClient.push(1);
    }
  }

  firstOppByClient.forEach((opp, clientId) => {
    const client = clientById.get(clientId);
    if (!client) return;
    const d = tatDaysBetween(opp.createdAt, client.createdAt);
    if (d != null) accum.clientToOpportunity.push(d);
  });

  for (const opp of opportunities) {
    let firstPipelineDate = null;
    if (Array.isArray(opp.commentsSection)) {
      for (const c of opp.commentsSection) {
        if (PIPELINE_STATUS_SET.has(c.tag)) {
          if (!firstPipelineDate || new Date(c.createdAt) < new Date(firstPipelineDate)) {
            firstPipelineDate = c.createdAt;
          }
        }
      }
    }
    const dPipe = tatDaysBetween(firstPipelineDate, opp.createdAt);
    if (dPipe != null) accum.opportunityToPipeline.push(dPipe);

    let siteVisitDate = null;
    if (Array.isArray(opp.commentsSection)) {
      for (const c of opp.commentsSection) {
        if (c?.sitevisit?.date) {
          if (!siteVisitDate || new Date(c.sitevisit.date) < new Date(siteVisitDate)) {
            siteVisitDate = c.sitevisit.date;
          }
        } else if (typeof c.tag === "string" && c.tag.toLowerCase().includes("site visit")) {
          if (!siteVisitDate || new Date(c.createdAt) < new Date(siteVisitDate)) {
            siteVisitDate = c.createdAt;
          }
        }
      }
    }
    const dVisit = tatDaysBetween(siteVisitDate, opp.createdAt);
    if (dVisit != null) accum.opportunityToSiteVisit.push(dVisit);

    const loiDate = opp?.loaDetails?.dateOfLOI || opp?.loaDetails?.whenCreated || null;
    const dLoi = tatDaysBetween(loiDate, siteVisitDate);
    if (dLoi != null) accum.siteVisitToLoi.push(dLoi);

    const agreementDate = opp?.agreementDetails?.date || opp?.agreementDetails?.whenCreated || null;
    const dAg = tatDaysBetween(agreementDate, loiDate);
    if (dAg != null) accum.loiToAgreement.push(dAg);
  }

  const rows = [
    {
      key: "leadToClient",
      metric: "Lead → Client",
      count: accum.leadToClient.length,
      averageDays: avgDays(accum.leadToClient),
      benchmarkDays: TAT_BENCHMARK_DAYS.leadToClient,
    },
    {
      key: "clientToOpportunity",
      metric: "Client → Opportunity",
      count: accum.clientToOpportunity.length,
      averageDays: avgDays(accum.clientToOpportunity),
      benchmarkDays: TAT_BENCHMARK_DAYS.clientToOpportunity,
    },
    {
      key: "opportunityToPipeline",
      metric: "Opportunity → Pipeline",
      count: accum.opportunityToPipeline.length,
      averageDays: avgDays(accum.opportunityToPipeline),
      benchmarkDays: TAT_BENCHMARK_DAYS.tagDefault,
    },
    {
      key: "opportunityToSiteVisit",
      metric: "Opportunity → Site visit",
      count: accum.opportunityToSiteVisit.length,
      averageDays: avgDays(accum.opportunityToSiteVisit),
      benchmarkDays: tagBenchmarkDays("Site Visit Done"),
    },
    {
      key: "siteVisitToLoi",
      metric: "Site visit → LOI",
      count: accum.siteVisitToLoi.length,
      averageDays: avgDays(accum.siteVisitToLoi),
      benchmarkDays: tagBenchmarkDays("LOI"),
    },
    {
      key: "loiToAgreement",
      metric: "LOI → Agreement",
      count: accum.loiToAgreement.length,
      averageDays: avgDays(accum.loiToAgreement),
      benchmarkDays: tagBenchmarkDays("Agreement"),
    },
  ];

  return rows.map((r) => ({
    ...r,
    exceedsBenchmark:
      r.averageDays != null && r.benchmarkDays != null && r.averageDays > r.benchmarkDays,
  }));
}

async function computeOpportunityOutcomes(start, end) {
  const opps = await Opportunity.find({ createdAt: { $gte: start, $lte: end } })
    .select("status")
    .lean();

  const outcomes = {
    total: opps.length,
    win: 0,
    approved: 0,
    rejected: 0,
    pipeline: 0,
    other: 0,
  };

  for (const opp of opps) {
    if (opp.status === "Win") outcomes.win += 1;
    else if (opp.status === "Approved") outcomes.approved += 1;
    else if (opp.status === "Reject") outcomes.rejected += 1;
    else if (opp.status && PIPELINE_STATUS_SET.has(opp.status)) outcomes.pipeline += 1;
    else outcomes.other += 1;
  }

  return outcomes;
}

async function computeStatusBreakdown(start, end) {
  const opps = await Opportunity.find({ createdAt: { $gte: start, $lte: end } })
    .select("status")
    .lean();

  const counts = {};
  for (const opp of opps) {
    const s = opp.status || "Unknown";
    counts[s] = (counts[s] || 0) + 1;
  }

  return Object.entries(counts)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
}

async function computePortfolioTotals(start, end) {
  const filter = { createdAt: { $gte: start, $lte: end } };
  const [leads, clients, properties, opportunities] = await Promise.all([
    Lead.countDocuments(filter),
    Client.countDocuments(filter),
    Property.countDocuments(filter),
    Opportunity.countDocuments(filter),
  ]);
  return { leads, clients, properties, opportunities };
}

async function computeEmployeeTatSummaries(start, end, employeeUserIds) {
  if (!employeeUserIds?.length) return [];

  const users = await User.find({ _id: { $in: employeeUserIds } })
    .select("_id name role")
    .lean();

  const leads = await Lead.find({
    $or: [{ createdAt: { $gte: start, $lte: end } }, { convertedAt: { $gte: start, $lte: end } }],
  })
    .select("whoConverted convertedAt createdAt convertedTo isConverted assignedTo")
    .lean();

  const clients = await Client.find({ createdAt: { $gte: start, $lte: end } })
    .select("_id createdAt assignedTo whoConverted")
    .lean();

  const opportunities = await Opportunity.find({ createdAt: { $gte: start, $lte: end } })
    .select("client createdAt whoLinkthis")
    .lean();

  const clientById = new Map(clients.map((c) => [String(c._id), c]));
  const firstOppByClient = new Map();
  for (const opp of opportunities) {
    const cid = String(opp.client);
    const prev = firstOppByClient.get(cid);
    if (!prev || new Date(opp.createdAt) < new Date(prev.createdAt)) {
      firstOppByClient.set(cid, opp);
    }
  }

  const summaries = [];

  for (const user of users) {
    const uid = String(user._id);
    const leadToClientDays = [];

    for (const lead of leads) {
      if (!lead.isConverted || String(lead.whoConverted) !== uid) continue;
      if (!lead.convertedAt || new Date(lead.convertedAt) < start || new Date(lead.convertedAt) > end) {
        continue;
      }
      const client = lead.convertedTo ? clientById.get(String(lead.convertedTo)) : null;
      if (client) {
        const d = tatDaysBetween(client.createdAt, lead.createdAt);
        if (d != null) leadToClientDays.push(d);
      }
    }

    const clientToOppDays = [];
    let oppsLinked = 0;
    firstOppByClient.forEach((opp, clientId) => {
      if (String(opp.whoLinkthis) !== uid) return;
      const c = clientById.get(clientId);
      if (!c) return;
      oppsLinked += 1;
      const d = tatDaysBetween(opp.createdAt, c.createdAt);
      if (d != null) clientToOppDays.push(d);
    });

    const avgLeadClient = avgDays(leadToClientDays);
    const avgClientOpp = avgDays(clientToOppDays);

    summaries.push({
      userId: user._id,
      name: user.name,
      role: user.role,
      leadToClient: {
        averageDays: avgLeadClient,
        benchmarkDays: TAT_BENCHMARK_DAYS.leadToClient,
        exceedsBenchmark:
          avgLeadClient != null && avgLeadClient > TAT_BENCHMARK_DAYS.leadToClient,
        sampleSize: leadToClientDays.length,
      },
      clientToOpportunity: {
        averageDays: avgClientOpp,
        benchmarkDays: TAT_BENCHMARK_DAYS.clientToOpportunity,
        exceedsBenchmark:
          avgClientOpp != null && avgClientOpp > TAT_BENCHMARK_DAYS.clientToOpportunity,
        sampleSize: oppsLinked,
      },
    });
  }

  return summaries;
}

/**
 * Full CRM report bridge for AI Insights period window.
 */
async function buildCrmReportEnrichment(start, end, employeeUserIds = []) {
  const [extendedFunnel, companyTat, opportunityOutcomes, statusBreakdown, portfolioTotals] =
    await Promise.all([
      computeCompanyFunnelForPeriod(start, end),
      computeCompanyTat(start, end),
      computeOpportunityOutcomes(start, end),
      computeStatusBreakdown(start, end),
      computePortfolioTotals(start, end),
    ]);

  const employeeTat = await computeEmployeeTatSummaries(start, end, employeeUserIds);

  const tatBreaches = companyTat.filter((r) => r.exceedsBenchmark && r.count > 0);

  return {
    source: "crm_report_controller_bridge",
    extendedFunnel,
    companyTat,
    tatBreaches,
    opportunityOutcomes,
    statusBreakdown,
    portfolioTotals,
    employeeTat,
    benchmarks: TAT_BENCHMARK_DAYS,
  };
}

module.exports = {
  buildCrmReportEnrichment,
  computeCompanyTat,
  computeCompanyFunnelForPeriod,
};
