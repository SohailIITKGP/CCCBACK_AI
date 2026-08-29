const InsightReport = require("../../models/InsightReport");
const KpiHistory = require("../../models/KpiHistory");
const { sendInsightDigest } = require("./insightEmailService");
const { enrichInsightDocument } = require("./insightPresentationService");
const { buildExecutiveReport } = require("./insightReportSynthesisService");
const { buildCrmReportEnrichment } = require("./insightReportMetricsService");
const {
  getPeriodWindows,
  normalizeRateToRatio,
} = require("./periodUtils");
const {
  buildAggregationSnapshot,
  buildEmployeeHighlights,
  computeEmployeeEfficiencyScore,
  computeAtRiskOpportunities,
} = require("./insightAggregationService");
const { runRuleEngine } = require("./ruleEngine");
const { runScoringEngine } = require("./scoringEngine");
const { runRootCauseEngine, buildHeadline } = require("./rootCauseEngine");
const { buildRecommendations, buildExpectedImpact } = require("./recommendationPlaybook");
const { deltaPct } = require("./periodUtils");

function buildProblems(flags, scores, snapshot) {
  const problems = [];
  const seen = new Set();

  for (const flag of flags) {
    if (flag.id === "SLOW_RESPONSE" && !seen.has("slow_response")) {
      problems.push({ id: "slow_response", label: "Slow response time", severity: flag.severity });
      seen.add("slow_response");
    }
    if (
      (flag.id === "OVERDUE_TASK_SPIKE" || flag.id === "PROPOSAL_FOLLOWUP_DROP") &&
      !seen.has("inconsistent_followups")
    ) {
      problems.push({
        id: "inconsistent_followups",
        label: "Inconsistent follow-ups",
        severity: flag.severity,
      });
      seen.add("inconsistent_followups");
    }
  }

  if (scores.subScores.followUpDiscipline < 60 && !seen.has("inconsistent_followups")) {
    problems.push({
      id: "inconsistent_followups",
      label: "Inconsistent follow-ups",
      severity: "MEDIUM",
    });
  }

  if (
    snapshot.current.responseTimeHours != null &&
    snapshot.current.responseTimeHours >
      (snapshot.teamBenchmarks?.responseTimeHoursP20 || 4.2) * 2 &&
    !seen.has("slow_response")
  ) {
    problems.push({ id: "slow_response", label: "Slow response time", severity: "HIGH" });
  }

  return problems;
}

function buildStrongAreas(scores, snapshot) {
  const areas = [];
  const auditEvents = snapshot.current.lifecycle?.auditActivity?.totalEvents || 0;
  if (scores.subScores.engagement >= 75 && auditEvents >= 15) {
    areas.push({
      id: "client_engagement",
      label: "High client engagement",
      evidence: `${auditEvents} audited lifecycle events this period`,
    });
  }
  if (scores.subScores.pipelineHealth >= 75) {
    areas.push({
      id: "pipeline_health",
      label: "Healthy pipeline progression",
      evidence: "Low stuck-deal ratio relative to active pipeline",
    });
  }
  if (snapshot.deltas?.leadsCreatedPct > 5) {
    areas.push({
      id: "lead_volume",
      label: "Strong lead inflow",
      evidence: `Lead volume up ${snapshot.deltas.leadsCreatedPct}% vs prior period`,
    });
  }
  return areas;
}

function buildMainBottleneck(snapshot, rootCauses) {
  const top = rootCauses[0];
  if (top?.factor === "response_time") {
    return {
      stage: "post_inquiry",
      label: "Slow response time after inquiry submission",
      detail:
        snapshot.current.proposalToCloseRate < 0.08
          ? "Most drop-off occurs after proposal stage"
          : "Response delays correlate with conversion decline",
      confidence: top.confidence || "MEDIUM",
    };
  }
  if (top?.factor === "proposal_follow_up") {
    return {
      stage: "post_proposal",
      label: "Proposal follow-up completion dropped",
      detail: `Proposal-to-close rate is ${Math.round((snapshot.current.proposalToCloseRate || 0) * 100)}%`,
      confidence: top.confidence || "MEDIUM",
    };
  }
  if (top?.factor === "high_intent_inactive") {
    return {
      stage: "lead_nurturing",
      label: "Hot/High priority leads going inactive",
      detail: `${top.count} leads with no activity in 7+ days`,
      confidence: "HIGH",
    };
  }

  if (
    top?.factor === "client_to_property_stall" ||
    top?.factor === "converted_no_property"
  ) {
    const n = snapshot.current.lifecycle?.dropoffs?.clientsNoPropertyAfterConvert || 0;
    return {
      stage: "client_to_property",
      label: "Stalled after client conversion — property not linked",
      detail: `${n} converted clients still have no property link (${snapshot.current.lifecycle?.dropoffs?.thresholdDays}+ days)`,
      confidence: top.confidence || "HIGH",
    };
  }

  if (top?.factor === "client_to_opportunity_stall") {
    return {
      stage: "property_to_opportunity",
      label: "Property linked but opportunity pipeline not growing",
      detail: "Client → property → opportunity chain is slower than prior period",
      confidence: top.confidence || "HIGH",
    };
  }

  if (snapshot.current.stuckDeals?.count > 0) {
    return {
      stage: "pipeline",
      label: "Deals stuck in pipeline",
      detail: `${snapshot.current.stuckDeals.count} opportunities with no update in ${snapshot.current.stuckDeals.thresholdDays}+ days`,
      confidence: "HIGH",
    };
  }

  return {
    stage: "general",
    label: "Monitor funnel conversion and task discipline",
    detail: "No single dominant bottleneck detected",
    confidence: "LOW",
  };
}

function buildPerformanceIssues(snapshot, teamBenchmarks) {
  const issues = [];
  const teamAvg = Math.round((teamBenchmarks.avgCompletionRate ?? 0.7) * 100);
  const currentRate = Math.round(
    (normalizeRateToRatio(snapshot.current.tasks?.company?.completionRate) ?? 0) * 100
  );

  if (currentRate < teamAvg) {
    issues.push(`Follow-up consistency is below team average (${currentRate}% vs ${teamAvg}%)`);
  }

  const propClose = Math.round((snapshot.current.proposalToCloseRate || 0) * 100);
  if (propClose < 8) {
    issues.push(`Proposal-to-close conversion is only ${propClose}%`);
  }

  if (
    snapshot.current.responseTimeHours != null &&
    snapshot.current.responseTimeHours > teamBenchmarks.responseTimeHoursP20
  ) {
    const src = snapshot.current.responseTimeSource === "audit" ? "audit trail" : "lead timestamps";
    issues.push(
      `Average first response ${snapshot.current.responseTimeHours}h via ${src} (target: ${teamBenchmarks.responseTimeHoursP20}h)`
    );
  }

  const dropoffs = snapshot.current.lifecycle?.dropoffs;
  if (dropoffs?.period?.stillNoProperty > 0) {
    issues.push(
      `${dropoffs.period.stillNoProperty} of ${dropoffs.period.leadsConverted} conversions this period still have no property link`
    );
  } else if (dropoffs?.clientsNoPropertyAfterConvert > 0) {
    issues.push(
      `${dropoffs.clientsNoPropertyAfterConvert} company-wide converted clients with no property link (${dropoffs.thresholdDays}+ days backlog)`
    );
  }

  const cohort = snapshot.current.lifecycle?.chain?.cohort;
  if (cohort?.leadsConverted > 0 && cohort.clientToOpportunityRate < 0.3) {
    issues.push(
      `Only ${Math.round(cohort.clientToOpportunityRate * 100)}% of converted leads reached opportunity stage`
    );
  }

  return issues;
}

function buildTrendsFromHistory(currentKpi, historyRows) {
  const trends = {
    leadConversion: { momentum: "stable", streakWeeks: 0 },
    overdueTasks: { momentum: "stable", streakWeeks: 0 },
    followUpDelay: { momentum: "stable", streakWeeks: 0 },
  };

  if (historyRows.length < 2) return trends;

  const sorted = [...historyRows].sort(
    (a, b) => new Date(a.periodEnd) - new Date(b.periodEnd)
  );

  let overdueStreak = 0;
  for (let i = sorted.length - 1; i > 0; i -= 1) {
    if ((sorted[i].metrics?.overdueTasks || 0) > (sorted[i - 1].metrics?.overdueTasks || 0)) {
      overdueStreak += 1;
    } else break;
  }

  trends.overdueTasks = {
    momentum: overdueStreak >= 2 ? "worsening" : "stable",
    streakWeeks: overdueStreak,
  };

  if (currentKpi?.leadToClientConversion != null && sorted.length >= 2) {
    const prev = sorted[sorted.length - 2]?.metrics?.leadToClientConversion;
    const cur = currentKpi.leadToClientConversion;
    trends.leadConversion = {
      momentum: cur < prev ? "down" : cur > prev ? "up" : "stable",
      streakWeeks: overdueStreak > 0 ? overdueStreak : 0,
    };
  }

  trends.followUpDelay = { ...trends.overdueTasks };

  return trends;
}

function buildExecutiveSummary(headline, rootCauses, scores, trends, lifecycleCohort) {
  const bullets = [headline.sentence];

  if (trends.overdueTasks.momentum === "worsening" && trends.overdueTasks.streakWeeks >= 2) {
    bullets.push(
      `Overdue follow-up tasks worsening for ${trends.overdueTasks.streakWeeks} consecutive periods`
    );
  }

  if (rootCauses[0]) {
    bullets.push(`Primary driver: ${rootCauses[0].label}`);
  }

  if (lifecycleCohort?.endToEndRate != null) {
    bullets.push(
      `Lead → opportunity end-to-end rate: ${Math.round(lifecycleCohort.endToEndRate * 100)}%`
    );
  }

  bullets.push(
    `Efficiency score ${scores.efficiencyScore}/100 (${scores.riskLevel} risk)`
  );

  return bullets.slice(0, 5);
}

async function assembleInsightDocument(snapshot, windows) {
  const flags = runRuleEngine(snapshot);
  const scores = runScoringEngine(snapshot);
  const headline = buildHeadline(snapshot);
  const rootCauses = runRootCauseEngine(snapshot, headline);
  const problems = buildProblems(flags, scores, snapshot);
  const strongAreas = buildStrongAreas(scores, snapshot);
  const taskByUser = snapshot.current.tasks?.byUser || [];

  const employeeHighlights = buildEmployeeHighlights(
    snapshot.current,
    snapshot.previous,
    snapshot.teamBenchmarks,
    taskByUser
  );

  for (const h of employeeHighlights) {
    const vol = snapshot.current.employeeVolumes?.find(
      (e) => String(e.userId) === String(h.userId)
    );
    const taskRow = taskByUser.find(
      (u) => String(u.employee?._id || u.employee) === String(h.userId)
    );
    h.efficiencyScore = computeEmployeeEfficiencyScore(
      vol || { leadsHandled: 0, leadsConverted: 0 },
      taskRow,
      snapshot.teamBenchmarks,
      scores.efficiencyScore
    );
  }

  const historyRows = await KpiHistory.find({
    period: windows.period,
  })
    .sort({ periodEnd: -1 })
    .limit(12)
    .lean();

  const trends = buildTrendsFromHistory(
    { leadToClientConversion: snapshot.current.leadToClientConversion },
    historyRows
  );

  const recommendations = buildRecommendations(flags, problems);
  const expectedImpact = buildExpectedImpact(headline, rootCauses, historyRows.length);
  const atRiskOpportunities = await computeAtRiskOpportunities(windows.periodEnd);
  const opportunityAging = snapshot.current.opportunityAging;

  const funnelDelta = {
    leadsCreated: deltaPct(
      snapshot.current.funnel.leadsCreated,
      snapshot.previous.funnel.leadsCreated
    ),
    leadsConverted: deltaPct(
      snapshot.current.funnel.leadsConverted,
      snapshot.previous.funnel.leadsConverted
    ),
    siteVisitDone: deltaPct(
      snapshot.current.funnel.siteVisitDone,
      snapshot.previous.funnel.siteVisitDone
    ),
    wins: deltaPct(snapshot.current.funnel.wins, snapshot.previous.funnel.wins),
    auditActivityPct: deltaPct(
      snapshot.current.lifecycle?.auditActivity?.totalEvents,
      snapshot.previous.lifecycle?.auditActivity?.totalEvents
    ),
  };

  const employeeIds = (snapshot.current.employeeVolumes || []).map((e) => e.userId);
  const crmReportMetrics = await buildCrmReportEnrichment(
    windows.periodStart,
    windows.periodEnd,
    employeeIds
  );

  const baseDocument = {
    crmReportMetrics,
    meta: {
      ...snapshot.meta,
      generatedAt: new Date().toISOString(),
      scope: "company",
      periodLabel:
        snapshot.meta?.period === "yearly"
          ? "Yearly (last 365 days)"
          : snapshot.meta?.period === "monthly"
            ? "Monthly (last 30 days)"
            : snapshot.meta?.period === "quarterly"
              ? "Quarterly (last 90 days)"
              : "Weekly (last 7 days)",
    },
    headline,
    rootCauses,
    mostAffectedEmployees: snapshot.mostAffectedEmployees.slice(0, 5),
    scores,
    trends,
    problems,
    strongAreas,
    funnel: {
      current: snapshot.current.funnel,
      previous: snapshot.previous.funnel,
      deltaPct: funnelDelta,
    },
    employeeHighlights,
    mainBottleneck: buildMainBottleneck(snapshot, rootCauses),
    performanceIssues: buildPerformanceIssues(snapshot, snapshot.teamBenchmarks),
    recommendations,
    expectedImpact,
    atRiskOpportunities,
    stuckDeals: snapshot.current.stuckDeals,
    lifecycleChain: snapshot.current.lifecycle?.chain,
    lifecycleDropoffs: snapshot.current.lifecycle?.dropoffs,
    pipelineInventory: snapshot.current.pipelineInventory,
    auditLifecycle: snapshot.current.lifecycle?.auditActivity,
    flags,
    narrative: {
      executiveSummary: buildExecutiveSummary(
        headline,
        rootCauses,
        scores,
        trends,
        snapshot.current.lifecycle?.chain?.cohort
      ),
      polishedByAI: false,
      aiModel: null,
    },
  };

  const enriched = enrichInsightDocument(baseDocument, opportunityAging);
  enriched.executiveReport = buildExecutiveReport(
    enriched,
    { ...snapshot, meta: { ...enriched.meta, period: windows.period } },
    historyRows,
    null
  );
  return enriched;
}

async function persistKpiHistory(period, periodEnd, snapshot, scores) {
  await KpiHistory.findOneAndUpdate(
    { period, periodEnd },
    {
      period,
      periodEnd,
      metrics: {
        efficiencyScore: scores.efficiencyScore,
        leadToClientConversion: snapshot.current.leadToClientConversion,
        overdueTasks: snapshot.current.tasks?.company?.overdue,
        stuckDeals: snapshot.current.stuckDeals?.count,
        proposalToCloseRate: snapshot.current.proposalToCloseRate,
        responseTimeHours: snapshot.current.responseTimeHours,
        leadsCreated: snapshot.current.funnel?.leadsCreated,
        leadsConverted: snapshot.current.funnel?.leadsConverted,
      },
    },
    { upsert: true, new: true }
  );
}

/**
 * Rolling windows are keyed by periodEnd (IST end-of-day anchor).
 */
async function findLatestReportForWindow(period, periodEnd) {
  return InsightReport.findOne({
    period,
    scope: "company",
    status: "complete",
    periodEnd,
  })
    .sort({ generatedAt: -1 })
    .lean();
}

async function deleteReportsForWindow(period, periodEnd) {
  const exact = await InsightReport.deleteMany({
    period,
    scope: "company",
    periodEnd,
  });
  return exact.deletedCount || 0;
}

/** Force regenerate: remove every cached report for this period type. */
async function deleteAllReportsForPeriod(period) {
  const result = await InsightReport.deleteMany({
    period,
    scope: "company",
  });
  return result.deletedCount || 0;
}

async function recordEmailDigest(reportId, emailResult) {
  await InsightReport.updateOne(
    { _id: reportId },
    {
      emailDigest: {
        sent: emailResult.sent,
        sentAt: emailResult.sent ? new Date() : null,
        recipientCount: emailResult.recipientCount || 0,
        error: emailResult.sent ? null : emailResult.reason || "failed",
      },
    }
  );
}

async function generateInsightReport({
  period = "weekly",
  generatedBy = "api",
  force = false,
} = {}) {
  const windows = getPeriodWindows(period);
  const { periodStart, periodEnd } = windows;

  if (force) {
    const removed = await deleteAllReportsForPeriod(period);
    console.log(
      `[insights] Force regenerate ${period}: removed ${removed} cached report(s), window ends ${periodEnd.toISOString()}`
    );
  } else {
    const existing = await findLatestReportForWindow(period, periodEnd);
    if (existing) {
      return existing;
    }
  }

  const snapshot = await buildAggregationSnapshot(windows);
  const document = await assembleInsightDocument(snapshot, windows);
  const scores = document.scores;

  await persistKpiHistory(period, periodEnd, snapshot, scores);

  const now = new Date();
  const report = await InsightReport.create({
    period,
    periodStart,
    periodEnd,
    scope: "company",
    document,
    status: "complete",
    generatedBy,
    modelVersion: "rule-only-v2",
    generatedAt: now,
  });

  if (document.executiveReport?.meta) {
    document.executiveReport.meta.reportId = String(report._id).slice(-8).toUpperCase();
    await InsightReport.updateOne({ _id: report._id }, { $set: { document } });
    report.document = document;
  }

  console.log(
    `[insights] Created report ${report._id} (${period}) generatedAt=${now.toISOString()}`
  );

  return report;
}

/**
 * Weekly cron: generate report (if missing) + email Managers & Super Admin.
 */
async function runScheduledWeeklyInsights() {
  const period = "weekly";
  const windows = getPeriodWindows(period);

  console.log(
    `[insights] Weekly job started (${windows.periodStart.toISOString()} → ${windows.periodEnd.toISOString()})`
  );

  let report = await findLatestReportForWindow(period, windows.periodEnd);

  if (!report) {
    report = await generateInsightReport({ period, generatedBy: "cron" });
    console.log(`[insights] Report created: ${report._id}`);
  } else {
    console.log(`[insights] Report already exists: ${report._id}`);
  }

  if (report.emailDigest?.sent) {
    console.log("[insights] Email digest already sent for this period — skipping");
    return { report, emailResult: { sent: true, skipped: true, reason: "already_sent" } };
  }

  const reportPayload = {
    document: report.document,
    generatedAt: report.generatedAt,
  };
  const emailResult = await sendInsightDigest(reportPayload);
  await recordEmailDigest(report._id, emailResult);

  console.log(
    `[insights] Weekly job finished. email=${emailResult.sent} recipients=${emailResult.recipientCount || 0}`
  );

  return { report, emailResult };
}

async function getLatestReport(period = "weekly") {
  const windows = getPeriodWindows(period);
  const forWindow = await findLatestReportForWindow(period, windows.periodEnd);
  if (forWindow) return forWindow;

  return InsightReport.findOne({ period, scope: "company", status: "complete" })
    .sort({ generatedAt: -1 })
    .lean();
}

async function getReportHistory(period = "weekly", limit = 12) {
  return InsightReport.find({ period, scope: "company", status: "complete" })
    .sort({ periodEnd: -1 })
    .limit(limit)
    .select("period periodStart periodEnd generatedAt document.scores document.headline")
    .lean();
}

module.exports = {
  generateInsightReport,
  getLatestReport,
  getReportHistory,
  assembleInsightDocument,
  buildAggregationSnapshot,
  runScheduledWeeklyInsights,
};
