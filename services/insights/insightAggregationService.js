const Lead = require("../../models/Lead");
const Client = require("../../models/Client");
const Opportunity = require("../../models/Opportunity");
const FollowUpTask = require("../../models/FollowUpTask");
const AuditLog = require("../../models/AuditLog");
const User = require("../../models/User");
const { PIPELINE_STATUSES } = require("../../utils/opportunityPipelineList");
const {
  countOpportunityStages,
  hasLoiSign,
  hasAgreement,
} = require("../../utils/adminFunnelStages");
const { getEmployeeReports } = require("../followUpTaskService");
const { buildLifecycleSnapshot } = require("./insightLifecycleService");
const {
  deltaPct,
  safeRatio,
  formatDateISO,
  normalizeRateToRatio,
} = require("./periodUtils");

const HIGH_INTENT_PRIORITIES = (
  process.env.INSIGHTS_HIGH_INTENT_PRIORITIES || "Hot,High"
).split(",").map((s) => s.trim());

const STUCK_DAYS = parseInt(process.env.INSIGHTS_STUCK_DAYS || "7", 10);
const TAT_BENCHMARK_DAYS_LEAD_CLIENT = 1;

const EMPLOYEE_ROLES = [
  "Lead-Employee",
  "BO-Client",
  "BO-Lead",
  "FE-Property",
  "Product-Manager",
  "Manager",
];

function dateInBounds(date, start, end) {
  if (!date) return false;
  const d = new Date(date);
  return d >= start && d <= end;
}

function oppLastActivity(opp) {
  let last = opp.updatedAt ? new Date(opp.updatedAt) : new Date(opp.createdAt);
  if (Array.isArray(opp.commentsSection)) {
    for (const c of opp.commentsSection) {
      const cd = c.createdAt || c.updatedAt;
      if (cd && new Date(cd) > last) last = new Date(cd);
    }
  }
  return last;
}

function isPipelineOpp(opp) {
  if (opp.isVisibility === false) return false;
  return !!(opp.status && PIPELINE_STATUSES.includes(opp.status));
}

async function getFunnelMetrics(start, end) {
  const leads = await Lead.find({
    $or: [{ createdAt: { $gte: start, $lte: end } }, { convertedAt: { $gte: start, $lte: end } }],
  })
    .select("createdAt convertedAt isConverted whoConverted")
    .lean();

  const clients = await Client.find({ createdAt: { $gte: start, $lte: end } })
    .select("createdAt")
    .lean();

  const opps = await Opportunity.find({ createdAt: { $gte: start, $lte: end } })
    .select(
      "createdAt isVisibility status commentsSection loaDetails agreementDetails whoLinkthis proposalEmailSentAt updatedAt"
    )
    .lean();

  let leadsCreated = 0;
  let leadsConverted = 0;
  for (const lead of leads) {
    if (dateInBounds(lead.createdAt, start, end)) leadsCreated += 1;
    if (lead.isConverted && dateInBounds(lead.convertedAt, start, end)) leadsConverted += 1;
  }

  const oppMetrics = countOpportunityStages(opps);
  const wins = opps.filter((o) => o.status === "Win").length;

  return {
    leadsCreated,
    leadsConverted,
    clientsCreated: clients.length,
    clientsToOpportunity: opps.length,
    pipelineCount: oppMetrics.opportunityToPipeline,
    siteVisitDone: oppMetrics.opportunityToSiteVisitDone,
    loi: oppMetrics.loiSignCount,
    agreement: oppMetrics.loiToAgreement,
    wins,
  };
}

async function getHighIntentInactive(asOfDate) {
  const cutoff = new Date(asOfDate.getTime() - STUCK_DAYS * 24 * 60 * 60 * 1000);
  const count = await Lead.countDocuments({
    isConverted: false,
    priority: { $in: HIGH_INTENT_PRIORITIES },
    updatedAt: { $lt: cutoff },
  });
  return { count, thresholdDays: STUCK_DAYS };
}

async function getOpportunityAging(asOfDate) {
  const opps = await Opportunity.find({
    isVisibility: { $ne: false },
    status: { $in: PIPELINE_STATUSES },
  })
    .select("updatedAt createdAt commentsSection")
    .lean();

  const buckets = {
    days0_7: 0,
    days8_15: 0,
    days16_30: 0,
    days30_plus: 0,
    total: opps.length,
  };

  for (const opp of opps) {
    const last = oppLastActivity(opp);
    const days = Math.ceil((asOfDate - last) / (24 * 60 * 60 * 1000));
    if (days <= 7) buckets.days0_7 += 1;
    else if (days <= 15) buckets.days8_15 += 1;
    else if (days <= 30) buckets.days16_30 += 1;
    else buckets.days30_plus += 1;
  }

  return buckets;
}

async function getPipelineInventory(asOfDate) {
  const cutoff = new Date(asOfDate.getTime() - STUCK_DAYS * 24 * 60 * 60 * 1000);
  const opps = await Opportunity.find({
    isVisibility: { $ne: false },
    status: { $in: PIPELINE_STATUSES },
  })
    .select("updatedAt createdAt commentsSection")
    .lean();

  let stuckCount = 0;
  for (const opp of opps) {
    const last = oppLastActivity(opp);
    if (last < cutoff) stuckCount += 1;
  }

  return {
    totalInPipeline: opps.length,
    stuckCount,
    activeMoving: opps.length - stuckCount,
    thresholdDays: STUCK_DAYS,
  };
}

async function getStuckOpportunities(asOfDate, limit = 15) {
  const cutoff = new Date(asOfDate.getTime() - STUCK_DAYS * 24 * 60 * 60 * 1000);
  const opps = await Opportunity.find({ isVisibility: { $ne: false } })
    .select(
      "status updatedAt createdAt commentsSection whoLinkthis client property proposalEmailSentAt"
    )
    .populate("whoLinkthis", "name")
    .populate("client", "name")
    .populate("property", "name city")
    .lean();

  const stuck = [];
  for (const opp of opps) {
    if (!isPipelineOpp(opp)) continue;
    const last = oppLastActivity(opp);
    if (last >= cutoff) continue;
    const daysStuck = Math.ceil((asOfDate - last) / (24 * 60 * 60 * 1000));
    stuck.push({
      opportunityId: opp._id,
      status: opp.status,
      daysStuck,
      assignedTo: opp.whoLinkthis?.name || "Unassigned",
      clientName: opp.client?.name || "",
      propertyLabel: opp.property?.name || opp.property?.city || "",
      proposalSent: !!opp.proposalEmailSentAt,
    });
  }

  stuck.sort((a, b) => b.daysStuck - a.daysStuck);
  return { thresholdDays: STUCK_DAYS, count: stuck.length, top: stuck.slice(0, limit) };
}

async function getProposalMetrics(start, end) {
  const oppsWithProposal = await Opportunity.find({
    proposalEmailSentAt: { $ne: null },
  })
    .select("proposalEmailSentAt status commentsSection loaDetails agreementDetails")
    .lean();

  let sentInPeriod = 0;
  let withProposalTotal = 0;
  let progressed = 0;

  for (const opp of oppsWithProposal) {
    if (dateInBounds(opp.proposalEmailSentAt, start, end)) sentInPeriod += 1;
    if (new Date(opp.proposalEmailSentAt) <= end) {
      withProposalTotal += 1;
      if (
        opp.status === "Win" ||
        hasLoiSign(opp) ||
        hasAgreement(opp)
      ) {
        progressed += 1;
      }
    }
  }

  return {
    proposalsSentInPeriod: sentInPeriod,
    withProposalTotal,
    progressedToClose: progressed,
    proposalToCloseRate: safeRatio(progressed, withProposalTotal),
  };
}

async function getResponseTimeHours(start, end) {
  const leads = await Lead.find({
    whenassign: { $gte: start, $lte: end },
    assignedTo: { $ne: null },
  })
    .select("whenassign updatedAt")
    .lean();

  const hours = [];
  for (const lead of leads) {
    if (!lead.whenassign || !lead.updatedAt) continue;
    const assign = new Date(lead.whenassign);
    const updated = new Date(lead.updatedAt);
    if (updated <= assign) continue;
    const h = (updated - assign) / (1000 * 60 * 60);
    if (h >= 0 && h < 720) hours.push(h);
  }

  if (!hours.length) return null;
  const avg = hours.reduce((a, b) => a + b, 0) / hours.length;
  return Math.round(avg * 10) / 10;
}

async function getProposalFollowUpRate(start, end) {
  const oppsWithProposal = await Opportunity.find({
    proposalEmailSentAt: { $ne: null, $lte: end },
  })
    .select("_id")
    .lean();
  const oppIds = oppsWithProposal.map((o) => o._id);
  if (!oppIds.length) return null;

  const [completed, total] = await Promise.all([
    FollowUpTask.countDocuments({
      opportunity: { $in: oppIds },
      status: "Completed",
      completedAt: { $gte: start, $lte: end },
    }),
    FollowUpTask.countDocuments({
      opportunity: { $in: oppIds },
      $or: [
        { completedAt: { $gte: start, $lte: end } },
        { status: "Pending", dueDate: { $lte: end } },
      ],
    }),
  ]);

  return safeRatio(completed, total);
}

async function getTaskCompanyMetrics(start, end) {
  const reports = await getEmployeeReports({
    from: start.toISOString(),
    to: end.toISOString(),
  });

  let overdue = 0;
  let completed = 0;
  let totalAssigned = 0;

  for (const r of reports) {
    overdue += r.overdue || 0;
    completed += r.completed || 0;
    totalAssigned += r.totalAssigned || 0;
  }

  const pending = totalAssigned - completed;
  const completionRate = safeRatio(completed, totalAssigned);

  return {
    overdue,
    completed,
    pending,
    totalAssigned,
    completionRate,
    employeeCount: reports.length,
    byUser: reports,
  };
}

async function getTatBreaches(start, end) {
  const leads = await Lead.find({
    isConverted: true,
    convertedAt: { $gte: start, $lte: end },
    whenassign: { $ne: null },
  })
    .select("whenassign convertedAt")
    .lean();

  let breaches = 0;
  for (const lead of leads) {
    const days =
      (new Date(lead.convertedAt) - new Date(lead.whenassign)) / (1000 * 60 * 60 * 24);
    if (days > TAT_BENCHMARK_DAYS_LEAD_CLIENT) breaches += 1;
  }
  return breaches;
}

async function getAuditEngagement(start, end) {
  const count = await AuditLog.countDocuments({
    action: { $in: ["data_create", "data_update", "admin_action"] },
    "details.source": { $ne: "api_middleware" },
    resource: { $in: ["Lead", "Client", "Property", "Opportunity"] },
    createdAt: { $gte: start, $lte: end },
  });
  return { updateEvents: count };
}

async function getEmployeeVolumes(start, end) {
  const users = await User.find({
    role: { $in: EMPLOYEE_ROLES },
    status: "Active",
  })
    .select("name role")
    .lean();

  const volumes = [];
  for (const user of users) {
    const uid = user._id;
    const [leadsHandled, leadsConverted, oppsLinked] = await Promise.all([
      Lead.countDocuments({
        $or: [{ assignedTo: uid }, { createdBy: uid }],
        createdAt: { $gte: start, $lte: end },
      }),
      Lead.countDocuments({
        whoConverted: uid,
        isConverted: true,
        convertedAt: { $gte: start, $lte: end },
      }),
      Opportunity.countDocuments({
        whoLinkthis: uid,
        createdAt: { $gte: start, $lte: end },
      }),
    ]);

    if (leadsHandled === 0 && leadsConverted === 0 && oppsLinked === 0) continue;

    volumes.push({
      userId: uid,
      name: user.name,
      role: user.role,
      leadsHandled,
      leadsConverted,
      opportunitiesLinked: oppsLinked,
    });
  }

  return volumes;
}

async function computeAtRiskOpportunities(asOfDate, limit = 10) {
  const stuck = await getStuckOpportunities(asOfDate, 50);
  const atRisk = [];

  for (const deal of stuck.top) {
    let riskScore = Math.min(95, 40 + deal.daysStuck * 4);
    const reasons = [`no_update_${deal.daysStuck}_days`];
    if (deal.proposalSent) {
      riskScore += 10;
      reasons.push("proposal_sent_no_progress");
    }

    atRisk.push({
      opportunityId: deal.opportunityId,
      clientName: deal.clientName || deal.propertyLabel || "Opportunity",
      status: deal.status,
      riskScore: Math.min(100, riskScore),
      riskLevel: riskScore >= 80 ? "CRITICAL" : riskScore >= 65 ? "HIGH" : "MEDIUM",
      daysStuck: deal.daysStuck,
      assignedTo: deal.assignedTo,
      reasons,
    });
  }

  for (const deal of stuck.top) {
    const overdueTasks = await FollowUpTask.countDocuments({
      opportunity: deal.opportunityId,
      status: "Pending",
      dueDate: { $lt: asOfDate },
    });
    if (overdueTasks > 0) {
      const entry = atRisk.find((a) => String(a.opportunityId) === String(deal.opportunityId));
      if (entry) {
        entry.riskScore = Math.min(100, entry.riskScore + overdueTasks * 5);
        entry.reasons.push(`${overdueTasks}_overdue_followups`);
        if (entry.riskScore >= 80) entry.riskLevel = "CRITICAL";
      }
    }
  }

  atRisk.sort((a, b) => b.riskScore - a.riskScore);
  return atRisk.slice(0, limit);
}

async function buildPeriodMetrics(start, end, asOfDate) {
  const [
    funnel,
    highIntentInactive,
    pipelineInventory,
    opportunityAging,
    stuckDeals,
    proposal,
    responseTimeHeuristic,
    proposalFollowUpRate,
    tasks,
    tatBreaches,
    auditEngagement,
    employeeVolumes,
    lifecycle,
  ] = await Promise.all([
    getFunnelMetrics(start, end),
    getHighIntentInactive(asOfDate),
    getPipelineInventory(asOfDate),
    getOpportunityAging(asOfDate),
    getStuckOpportunities(asOfDate),
    getProposalMetrics(start, end),
    getResponseTimeHours(start, end),
    getProposalFollowUpRate(start, end),
    getTaskCompanyMetrics(start, end),
    getTatBreaches(start, end),
    getAuditEngagement(start, end),
    getEmployeeVolumes(start, end),
    buildLifecycleSnapshot(start, end, asOfDate),
  ]);

  const responseTimeHours =
    lifecycle.responseTimeAudit?.avgHours != null
      ? lifecycle.responseTimeAudit.avgHours
      : responseTimeHeuristic;
  const responseTimeSource =
    lifecycle.responseTimeAudit?.avgHours != null ? "audit" : "lead_updated_at";

  const leadToClientConversion = safeRatio(
    funnel.leadsConverted,
    funnel.leadsCreated
  );

  return {
    funnel,
    leadToClientConversion,
    highIntentInactive,
    stuckDeals,
    proposal,
    proposalToCloseRate: proposal.proposalToCloseRate,
    proposalFollowUpRate,
    responseTimeHours,
    responseTimeSource,
    lifecycle,
    pipelineInventory,
    opportunityAging,
    tasks: {
      company: {
        overdue: tasks?.overdue ?? 0,
        completed: tasks?.completed ?? 0,
        pending: tasks?.pending ?? 0,
        completionRate: tasks?.completionRate ?? 0,
      },
      byUser: tasks?.byUser ?? [],
    },
    tatBreaches,
    auditEngagement,
    employeeVolumes,
  };
}

function computeTeamBenchmarks(currentMetrics) {
  const byUser = currentMetrics.tasks?.byUser || [];
  const completionRates = byUser
    .map((u) => normalizeRateToRatio(u.completionRate))
    .filter((r) => r != null);
  const avgCompletionRate =
    completionRates.length
      ? completionRates.reduce((a, b) => a + b, 0) / completionRates.length
      : 0.7;

  const sorted = [...completionRates].sort((a, b) => b - a);
  const p20Idx = Math.max(0, Math.floor(sorted.length * 0.2) - 1);
  const topCompletion = sorted[p20Idx] ?? avgCompletionRate;

  const employeeVolumes = currentMetrics.employeeVolumes || [];
  const leadConvRates = employeeVolumes
    .filter((e) => e.leadsHandled > 0)
    .map((e) => safeRatio(e.leadsConverted, e.leadsHandled));
  const avgLeadConversion =
    leadConvRates.length
      ? leadConvRates.reduce((a, b) => a + b, 0) / leadConvRates.length
      : 0.15;

  return {
    avgCompletionRate,
    topCompletionRateP20: topCompletion,
    avgLeadConversion,
    responseTimeHoursP20: 4.2,
  };
}

function clampScore(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function computeEmployeeEfficiencyScore(vol, taskRow, teamBenchmarks, companyEfficiency) {
  const overdue = taskRow?.overdue ?? 0;
  const completion = normalizeRateToRatio(taskRow?.completionRate);
  const convRate = safeRatio(vol.leadsConverted, vol.leadsHandled);
  const teamConv = teamBenchmarks?.avgLeadConversion ?? 0.15;
  const teamCompletion = teamBenchmarks?.avgCompletionRate ?? 0.7;

  const convScore =
    vol.leadsHandled > 0
      ? clampScore(50 + ((convRate - teamConv) / Math.max(teamConv, 0.01)) * 30)
      : 50;
  const followScore =
    completion != null
      ? clampScore(
          completion * 75 -
            Math.min(35, overdue * 1.2) +
            (completion >= teamCompletion ? 6 : 0)
        )
      : clampScore(50 - Math.min(35, overdue * 1.2));

  const individual = clampScore(convScore * 0.45 + followScore * 0.55, 15, 98);
  if (companyEfficiency == null) return individual;
  return clampScore(companyEfficiency * 0.25 + individual * 0.75, 15, 98);
}

function computeImpactScores(current, previous, employeeVolumes) {
  const scores = [];

  for (const emp of employeeVolumes) {
    const taskRow = current.tasks?.byUser?.find(
      (u) => String(u.employee?._id || u.employee) === String(emp.userId)
    );

    let impact = 0;
    impact += (taskRow?.overdue || 0) * 3;
    impact += emp.leadsHandled > 0 && emp.leadsConverted === 0 ? 15 : 0;
    if (previous?.employeeVolumes) {
      const prev = previous.employeeVolumes.find(
        (e) => String(e.userId) === String(emp.userId)
      );
      if (prev && emp.leadsConverted < prev.leadsConverted) impact += 20;
    }

    scores.push({
      userId: emp.userId,
      name: emp.name,
      role: emp.role,
      impactScore: Math.min(100, impact),
    });
  }

  scores.sort((a, b) => b.impactScore - a.impactScore);
  return scores;
}

function buildEmployeeHighlights(current, previous, teamBenchmarks, taskByUser) {
  const highlights = [];
  const teamAvgCompletion = teamBenchmarks.avgCompletionRate || 0.7;

  for (const vol of current.employeeVolumes || []) {
    const taskRow = taskByUser.find(
      (u) => String(u.employee?._id || u.employee) === String(vol.userId)
    );
    const completionRate = normalizeRateToRatio(taskRow?.completionRate);
    const overdue = taskRow?.overdue ?? 0;
    const proposalRate = current.proposalToCloseRate;

    const issues = [];
    if (completionRate != null && completionRate < teamAvgCompletion) {
      issues.push(
        `Follow-up consistency ${Math.round(completionRate * 100)}% vs team ${Math.round(teamAvgCompletion * 100)}%`
      );
    }
    if (overdue >= 5) {
      issues.push(`${overdue} overdue follow-up tasks`);
    }
    if (vol.leadsHandled > 10 && vol.leadsConverted === 0) {
      issues.push("No lead conversions this period despite high volume");
    }

    let bottleneck = null;
    if (overdue >= 5) bottleneck = "Overdue follow-ups accumulating";
    else if (current.responseTimeHours > teamBenchmarks.responseTimeHoursP20) {
      bottleneck = "Slow response after inquiry";
    } else if (proposalRate < 0.05 && vol.opportunitiesLinked > 0) {
      bottleneck = "Drop-off after proposal stage";
    }

    highlights.push({
      userId: vol.userId,
      name: vol.name,
      role: vol.role,
      volume: {
        leadsHandled: vol.leadsHandled,
        leadsConverted: vol.leadsConverted,
        opportunitiesLinked: vol.opportunitiesLinked,
      },
      efficiencyScore: null,
      bottleneck,
      issues,
      recurringPatterns: [],
    });
  }

  return highlights.slice(0, 20);
}

/**
 * Build raw snapshot for current vs previous period.
 */
async function buildAggregationSnapshot(windows) {
  const { periodStart, periodEnd, previousStart, previousEnd, period } = windows;

  const [current, previous] = await Promise.all([
    buildPeriodMetrics(periodStart, periodEnd, periodEnd),
    buildPeriodMetrics(previousStart, previousEnd, previousEnd),
  ]);

  const teamBenchmarks = computeTeamBenchmarks(current);

  const deltas = {
    leadToClientConversionPct: deltaPct(
      current.leadToClientConversion,
      previous.leadToClientConversion
    ),
    responseTimeHoursPct: deltaPct(current.responseTimeHours, previous.responseTimeHours),
    proposalFollowUpRatePct: deltaPct(
      current.proposalFollowUpRate,
      previous.proposalFollowUpRate
    ),
    overdueTasksPct: deltaPct(
      current.tasks?.company?.overdue,
      previous.tasks?.company?.overdue
    ),
    leadsCreatedPct: deltaPct(current.funnel.leadsCreated, previous.funnel.leadsCreated),
    leadsConvertedPct: deltaPct(
      current.funnel.leadsConverted,
      previous.funnel.leadsConverted
    ),
    clientToPropertyRatePct: deltaPct(
      current.lifecycle?.chain?.cohort?.clientToPropertyRate,
      previous.lifecycle?.chain?.cohort?.clientToPropertyRate
    ),
    clientToOpportunityRatePct: deltaPct(
      current.lifecycle?.chain?.cohort?.clientToOpportunityRate,
      previous.lifecycle?.chain?.cohort?.clientToOpportunityRate
    ),
    endToEndRatePct: deltaPct(
      current.lifecycle?.chain?.cohort?.endToEndRate,
      previous.lifecycle?.chain?.cohort?.endToEndRate
    ),
    auditActivityPct: deltaPct(
      current.lifecycle?.auditActivity?.totalEvents,
      previous.lifecycle?.auditActivity?.totalEvents
    ),
    winsPct: deltaPct(current.funnel?.wins, previous.funnel?.wins),
  };

  const auditDelta = deltaPct(
    current.auditEngagement?.updateEvents,
    previous.auditEngagement?.updateEvents
  );
  current.auditEngagement.deltaPct = auditDelta;

  const mostAffectedEmployees = computeImpactScores(current, previous, current.employeeVolumes);

  return {
    meta: {
      period,
      periodStart: formatDateISO(periodStart),
      periodEnd: formatDateISO(periodEnd),
      previousStart: formatDateISO(previousStart),
      previousEnd: formatDateISO(previousEnd),
      timezone: "Asia/Kolkata",
    },
    current,
    previous,
    deltas,
    teamBenchmarks,
    mostAffectedEmployees,
  };
}

module.exports = {
  buildAggregationSnapshot,
  buildEmployeeHighlights,
  computeEmployeeEfficiencyScore,
  computeAtRiskOpportunities,
  STUCK_DAYS,
};
