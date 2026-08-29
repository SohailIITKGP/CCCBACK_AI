/**
 * Admin dashboard funnel — same stage logic as reportController.getAdminDashboardFunnel
 */
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const Opportunity = require("../models/Opportunity");
const { countOpportunityStages } = require("./adminFunnelStages");

function funnelRatio(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function dateInBounds(value, start, end) {
  if (!value) return false;
  const t = new Date(value);
  return t >= start && t <= end;
}

function convertedInWindow(lead, start, end) {
  if (!lead?.isConverted || !lead?.whoConverted) return false;
  if (!lead.convertedAt) return false;
  return dateInBounds(lead.convertedAt, start, end);
}

function buildFunnelSteps({
  leadsGenerated,
  leadsConverted,
  totalClients,
  totalOpportunityCount,
  oppMetrics,
}) {
  const {
    totalOpportunities,
    opportunityToPipeline,
    opportunityToSiteVisitDone,
    siteVisitDoneCount,
    siteVisitDoneToLoi,
    loiSignCount,
    loiToAgreement,
  } = oppMetrics;

  return [
    {
      key: "leadGenerated",
      label: "Lead generated",
      count: leadsGenerated,
      ratio: null,
      baseCount: null,
    },
    {
      key: "leadToClient",
      label: "Lead → Client",
      count: leadsConverted,
      baseCount: leadsGenerated,
      ratio: funnelRatio(leadsConverted, leadsGenerated),
    },
    {
      key: "clientToOpportunity",
      label: "Client → Opportunity",
      count: totalOpportunityCount,
      baseCount: totalClients,
      ratio: funnelRatio(totalOpportunityCount, totalClients),
    },
    {
      key: "opportunityToPipeline",
      label: "Opportunity → Pipeline",
      count: opportunityToPipeline,
      baseCount: totalOpportunities,
      ratio: funnelRatio(opportunityToPipeline, totalOpportunities),
    },
    {
      key: "opportunityToSiteVisitDone",
      label: "Opportunity → Site visit done",
      count: opportunityToSiteVisitDone,
      baseCount: totalOpportunities,
      ratio: funnelRatio(opportunityToSiteVisitDone, totalOpportunities),
    },
    {
      key: "siteVisitDoneToLoi",
      label: "Site visit → LOI sign",
      count: siteVisitDoneToLoi,
      baseCount: siteVisitDoneCount,
      ratio: funnelRatio(siteVisitDoneToLoi, siteVisitDoneCount),
    },
    {
      key: "loiToAgreement",
      label: "LOI → Agreement",
      count: loiToAgreement,
      baseCount: loiSignCount,
      ratio: funnelRatio(loiToAgreement, loiSignCount),
    },
  ];
}

async function computeCompanyFunnelForPeriod(start, end) {
  const leadQuery = {
    $or: [{ createdAt: { $gte: start, $lte: end } }, { convertedAt: { $gte: start, $lte: end } }],
  };

  const [leads, clients, opportunities] = await Promise.all([
    Lead.find(leadQuery)
      .select("createdBy whoConverted isConverted convertedAt createdAt")
      .lean(),
    Client.find({ createdAt: { $gte: start, $lte: end } }).select("createdAt").lean(),
    Opportunity.find({ createdAt: { $gte: start, $lte: end } })
      .select(
        "createdAt isVisibility status commentsSection loaDetails agreementDetails whoLinkthis"
      )
      .lean(),
  ]);

  let leadsGenerated = 0;
  let leadsConverted = 0;
  for (const lead of leads) {
    if (dateInBounds(lead.createdAt, start, end)) leadsGenerated += 1;
    if (convertedInWindow(lead, start, end)) leadsConverted += 1;
  }

  const totalClients = clients.length;
  const companyOpps = opportunities.filter((o) => dateInBounds(o.createdAt, start, end));
  const oppMetrics = countOpportunityStages(companyOpps);

  return buildFunnelSteps({
    leadsGenerated,
    leadsConverted,
    totalClients,
    totalOpportunityCount: companyOpps.length,
    oppMetrics,
  });
}

module.exports = {
  buildFunnelSteps,
  computeCompanyFunnelForPeriod,
};
