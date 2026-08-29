/**
 * Executive report synthesis — transforms metrics into memo-style intelligence.
 * All math stays deterministic; language is analytical, not LLM-generated.
 */

const { estimateBlockedPipeline } = require("./insightPresentationService");
const {
  deltaPct,
  safeRatio,
  normalizeRateToRatio,
  formatRatePct,
} = require("./periodUtils");

const RESPONSE_TARGET_HOURS = 2;
const TEAM_RESPONSE_BENCHMARK = 4.2;

function roundPct(v) {
  if (v == null) return null;
  return Math.round(v * 10) / 10;
}

function trendArrow(current, previous) {
  if (previous == null || current == null) return { arrow: "→", label: "stable" };
  const d = deltaPct(current, previous);
  if (d > 3) return { arrow: "↑", label: "improving" };
  if (d < -3) return { arrow: "↓", label: "declining" };
  return { arrow: "→", label: "stable" };
}

function buildReportMeta(doc, reportId, period) {
  const periodTitles = {
    weekly: "Weekly Executive Review",
    monthly: "Monthly Operations Review",
    quarterly: "Quarterly Strategic Review",
    yearly: "Annual Operations Review",
  };
  return {
    reportId: reportId ? String(reportId).slice(-8).toUpperCase() : "PENDING",
    title: "AI Operations Intelligence Report",
    subtitle: periodTitles[period] || "Executive Review",
    preparedFor: "Management Team · Super Admin",
    source: "CRM Operations Intelligence Engine",
    modelVersion: "rule-only-v2",
    periodLabel: doc.meta?.periodLabel || period,
    periodStart: doc.meta?.periodStart,
    periodEnd: doc.meta?.periodEnd,
  };
}

function buildConfidence(doc, snapshot) {
  const leadsCreated = snapshot.current.funnel?.leadsCreated || 0;
  const leadsConverted = snapshot.current.funnel?.leadsConverted || 0;
  const auditEvents = snapshot.current.lifecycle?.auditActivity?.totalEvents || 0;
  const kpiWeeks = snapshot.kpiHistoryLength || 0;

  let level = "MEDIUM";
  let sampleNote = "";
  const warnings = [];

  if (leadsCreated < 20) {
    level = "LOW";
    sampleNote = `Low lead volume (${leadsCreated} created) — percentage metrics may shift significantly with small changes.`;
    warnings.push("insufficient_lead_sample");
  } else if (leadsCreated >= 50 && kpiWeeks >= 4) {
    level = "HIGH";
    sampleNote = `Based on ${leadsCreated} leads and ${kpiWeeks} historical periods for trend context.`;
  } else {
    sampleNote = `Based on ${leadsCreated} leads created and ${leadsConverted} conversions this period.`;
  }

  if (auditEvents < 10) {
    warnings.push("limited_audit_activity");
    if (level === "HIGH") level = "MEDIUM";
    sampleNote += ` Audit trail volume is low (${auditEvents} events) — workflow movement signals are partial.`;
  }

  return {
    level,
    sampleNote,
    warnings,
    leadsCreated,
    leadsConverted,
    auditEvents,
    kpiPeriodsAvailable: kpiWeeks,
  };
}

function buildKeyFindings(doc, snapshot) {
  const findings = [];
  const { deltas } = snapshot;

  if (doc.headline?.direction === "down") {
    findings.push({
      severity: "high",
      text: `Lead-to-client conversion efficiency deteriorated ${Math.abs(doc.headline.deltaPct || 0)}% versus the prior period.`,
    });
  } else if (doc.headline?.direction === "up") {
    findings.push({
      severity: "positive",
      text: `Lead-to-client conversion improved ${doc.headline.deltaPct}% versus the prior period.`,
    });
  }

  if (deltas?.leadsCreatedPct != null && deltas.leadsCreatedPct <= -15) {
    findings.push({
      severity: "high",
      text: `Lead inflow declined ${Math.abs(deltas.leadsCreatedPct)}% — volume pressure compounds conversion issues.`,
    });
  } else if (deltas?.leadsCreatedPct != null && deltas.leadsCreatedPct >= 10) {
    findings.push({
      severity: "positive",
      text: `Lead inflow increased ${deltas.leadsCreatedPct}% — pipeline input is strengthening.`,
    });
  }

  const backlog = doc.lifecycleDropoffs?.clientsNoPropertyAfterConvert || 0;
  if (backlog >= 3) {
    findings.push({
      severity: "critical",
      text: `Workflow leakage: ${backlog} converted clients remain unlinked to properties (${doc.lifecycleDropoffs?.thresholdDays || 7}+ days).`,
    });
  }

  const periodUnlinked = doc.lifecycleDropoffs?.period?.stillNoProperty || 0;
  if (periodUnlinked > 0) {
    findings.push({
      severity: "warning",
      text: `${periodUnlinked} of ${doc.lifecycleDropoffs?.period?.leadsConverted || 0} conversions this period still have no property link.`,
    });
  }

  if (doc.scores?.subScores?.followUpDiscipline < 40) {
    findings.push({
      severity: "high",
      text: `Follow-up discipline score ${doc.scores.subScores.followUpDiscipline}/100 — overdue tasks are suppressing pipeline velocity.`,
    });
  }

  if (doc.trends?.overdueTasks?.momentum === "worsening" && doc.trends.overdueTasks.streakWeeks >= 2) {
    findings.push({
      severity: "warning",
      text: `Overdue follow-up tasks worsening for ${doc.trends.overdueTasks.streakWeeks} consecutive periods.`,
    });
  }

  const critical = (doc.atRiskOpportunities || []).filter(
    (o) => o.riskLevel === "CRITICAL" || o.riskScore >= 80
  );
  if (critical.length > 0) {
    findings.push({
      severity: "critical",
      text: `${critical.length} critical stagnant opportunity(ies) detected — immediate escalation recommended.`,
    });
  }

  if (doc.strongAreas?.length > 0) {
    findings.push({
      severity: "positive",
      text: `${doc.strongAreas[0].label} remains a relative strength this period.`,
    });
  }

  if (deltas?.winsPct != null && deltas.winsPct <= -50) {
    findings.push({
      severity: "high",
      text: `Win rate collapsed (${deltas.winsPct}% vs prior period) — closure execution needs review.`,
    });
  }

  const tatBreaches = doc.crmReportMetrics?.tatBreaches || [];
  for (const row of tatBreaches.slice(0, 2)) {
    findings.push({
      severity: "warning",
      text: `${row.metric} averaging ${row.averageDays}d (SLA ${row.benchmarkDays}d) — turnaround time exceeds benchmark.`,
    });
  }

  const outcomes = doc.crmReportMetrics?.opportunityOutcomes;
  if (outcomes?.rejected > 0 && outcomes.total > 0) {
    const rejPct = Math.round((outcomes.rejected / outcomes.total) * 100);
    if (rejPct >= 15) {
      findings.push({
        severity: "warning",
        text: `${outcomes.rejected} opportunities rejected (${rejPct}% of period volume) — review loss reasons in pipeline tags.`,
      });
    }
  }

  return findings.slice(0, 10);
}

function buildExecutiveBrief(doc, snapshot, keyFindings) {
  const paragraphs = [];
  const { current, previous, deltas } = snapshot;
  const convPct = roundPct((current.leadToClientConversion || 0) * 100);
  const prevConvPct = roundPct((previous.leadToClientConversion || 0) * 100);

  if (doc.headline?.direction === "down") {
    const volumeNote =
      deltas?.leadsCreatedPct != null && deltas.leadsCreatedPct > 3
        ? "despite stable lead inflow"
        : deltas?.leadsCreatedPct != null && deltas.leadsCreatedPct < -10
          ? "amid a significant decline in lead volume"
          : "in the current operating period";
    paragraphs.push(
      `Conversion efficiency deteriorated this period (${convPct}% vs ${prevConvPct}% prior) ${volumeNote}. Operational friction is reducing downstream opportunity creation rather than isolated funnel noise.`
    );
  } else if (doc.headline?.direction === "up") {
    paragraphs.push(
      `Conversion efficiency improved to ${convPct}% (from ${prevConvPct}%), indicating stronger execution across the lead-to-client stage.`
    );
  } else {
    paragraphs.push(
      `Conversion efficiency held steady at ${convPct}% this period, with no material shift versus the prior window.`
    );
  }

  const backlog = doc.lifecycleDropoffs?.clientsNoPropertyAfterConvert || 0;
  if (backlog >= 3) {
    paragraphs.push(
      `The primary structural issue is workflow leakage after client conversion: ${backlog} converted clients have remained without a property link for more than ${doc.lifecycleDropoffs?.thresholdDays || 7} days. This blocks the automatic opportunity creation path and inflates blocked pipeline estimates.`
    );
  }

  if (current.responseTimeHours != null && current.responseTimeHours > TEAM_RESPONSE_BENCHMARK) {
    paragraphs.push(
      `First-response latency remains elevated at ${current.responseTimeHours}h (team benchmark ${TEAM_RESPONSE_BENCHMARK}h, target ${RESPONSE_TARGET_HOURS}h), correlating with slower downstream movement.`
    );
  }

  if (doc.scores?.subScores?.followUpDiscipline < 50) {
    paragraphs.push(
      `Inconsistent follow-up completion (discipline score ${doc.scores.subScores.followUpDiscipline}/100) is compounding conversion and pipeline stagnation risks.`
    );
  }

  const immediateAttention = keyFindings
    .filter((f) => f.severity === "critical" || f.severity === "high")
    .map((f) => f.text.split("—")[0].split(":")[0].trim())
    .slice(0, 4);

  if (immediateAttention.length === 0 && doc.managerAttention?.length) {
    for (const item of doc.managerAttention.slice(0, 3)) {
      immediateAttention.push(item.title);
    }
  }

  return { paragraphs, immediateAttention };
}

function buildSynthesis(doc, snapshot) {
  const parts = [];
  const drivers = [];

  if (doc.scores?.subScores?.followUpDiscipline < 50) drivers.push("delayed follow-ups");
  if (doc.lifecycleDropoffs?.clientsNoPropertyAfterConvert >= 3) {
    drivers.push("unlinked converted clients");
  }
  if (snapshot.current.highIntentInactive?.count >= 10) {
    drivers.push("inactive high-intent leads");
  }
  if (
    snapshot.current.responseTimeHours != null &&
    snapshot.current.responseTimeHours > TEAM_RESPONSE_BENCHMARK
  ) {
    drivers.push("slow first response");
  }

  if (drivers.length >= 2) {
    parts.push(
      `The combination of ${drivers.slice(0, -1).join(", ")} and ${drivers[drivers.length - 1]} is suppressing downstream opportunity creation and conversion recovery.`
    );
  } else if (drivers.length === 1) {
    parts.push(`Primary operational drag: ${drivers[0]} — this is the highest-leverage fix for this period.`);
  } else if (doc.headline?.direction === "down") {
    parts.push(
      "Conversion decline appears distributed across multiple operational factors — a coordinated review of assignment, follow-up, and linking SLAs is warranted."
    );
  } else {
    parts.push("No dominant operational failure pattern detected — maintain discipline and monitor trend momentum.");
  }

  const endToEnd = snapshot.current.lifecycle?.chain?.cohort?.endToEndRate;
  if (endToEnd != null && endToEnd < 0.25) {
    parts.push(
      `End-to-end lead→opportunity rate of ${Math.round(endToEnd * 100)}% indicates structural workflow gaps beyond front-end conversion.`
    );
  }

  return parts.join(" ");
}

function buildBusinessImpact(doc, snapshot) {
  const items = [];
  const workflowLeakage = doc.revenueImpact?.workflowLeakage || estimateBlockedPipeline(
    doc.lifecycleDropoffs?.clientsNoPropertyAfterConvert || 0
  );
  const periodLeakage = doc.revenueImpact?.periodLeakage;

  if (workflowLeakage?.label) {
    items.push({
      label: "Estimated blocked pipeline (workflow leakage)",
      value: workflowLeakage.label,
      severity: "critical",
    });
  }

  const effCurrent = doc.scores?.efficiencyScore;
  const effPrev = snapshot.kpiHistory?.length >= 2
    ? snapshot.kpiHistory[snapshot.kpiHistory.length - 2]?.metrics?.efficiencyScore
    : null;
  if (effCurrent != null && effPrev != null) {
    const delta = effCurrent - effPrev;
    items.push({
      label: "Operational efficiency change vs prior period",
      value: `${delta > 0 ? "+" : ""}${delta} points`,
      severity: delta < -5 ? "high" : delta > 5 ? "positive" : "neutral",
    });
  }

  if (doc.headline?.direction === "down" && doc.headline.deltaPct != null) {
    const low = Math.round(Math.abs(doc.headline.deltaPct) * 0.6);
    const high = Math.round(Math.abs(doc.headline.deltaPct) * 1.1);
    items.push({
      label: "Potential conversion efficiency loss",
      value: `${low}–${high}%`,
      severity: "warning",
    });
  }

  if (snapshot.current.tasks?.company?.overdue > 0) {
    items.push({
      label: "Overdue follow-up tasks (operational drag)",
      value: String(snapshot.current.tasks.company.overdue),
      severity: snapshot.current.tasks.company.overdue >= 10 ? "high" : "warning",
    });
  }

  return {
    headline: workflowLeakage?.label
      ? `Estimated blocked pipeline: ${workflowLeakage.label}`
      : null,
    items,
    workflowLeakage,
    periodLeakage,
    disclaimer: "Revenue figures use configurable proxy per client — not audited financials.",
  };
}

function buildForecast(doc, snapshot, kpiHistory) {
  const outlook = [];
  const risks = [];

  const convTrend = doc.headline?.deltaPct;
  if (convTrend != null && convTrend < -5) {
    const projLow = Math.round(Math.abs(convTrend) * 0.5);
    const projHigh = Math.round(Math.abs(convTrend) * 1.2);
    outlook.push(
      `If current conversion trajectory continues, projected additional decline: ${projLow}–${projHigh}% next period.`
    );
  }

  const backlog = doc.lifecycleDropoffs?.clientsNoPropertyAfterConvert || 0;
  if (backlog >= 5) {
    const rev = estimateBlockedPipeline(backlog);
    const nextQ = estimateBlockedPipeline(Math.ceil(backlog * 1.3));
    outlook.push(
      `Unresolved property linking could extend blocked pipeline from ${rev?.label || "—"} toward ${nextQ?.label || "—"} if backlog grows 30%.`
    );
    risks.push("Workflow leakage accumulation without property assignment SLA");
  }

  if (doc.trends?.overdueTasks?.momentum === "worsening") {
    const streak = doc.trends.overdueTasks.streakWeeks || 1;
    outlook.push(
      `Overdue task momentum suggests pipeline stagnation may increase ~${Math.min(25, streak * 8)}% if not corrected.`
    );
    risks.push("Escalating overdue follow-up burden");
  }

  const stuckRatio =
    snapshot.current.pipelineInventory?.totalInPipeline > 0
      ? snapshot.current.pipelineInventory.stuckCount /
        snapshot.current.pipelineInventory.totalInPipeline
      : 0;
  if (stuckRatio > 0.4) {
    risks.push("High proportion of pipeline inactive 7+ days");
    outlook.push("Pipeline velocity at risk — majority of active deals show no recent movement.");
  }

  if (kpiHistory.length >= 3) {
    const scores = kpiHistory
      .slice(-3)
      .map((r) => r.metrics?.efficiencyScore)
      .filter((s) => s != null);
    if (scores.length === 3 && scores[2] < scores[1] && scores[1] < scores[0]) {
      risks.push("Three-period efficiency decline trend");
    }
  }

  return {
    title: "Forecast & risk outlook",
    outlook: outlook.slice(0, 4),
    risks: risks.slice(0, 5),
    confidence: outlook.length > 0 ? "MEDIUM" : "LOW",
    disclaimer: "Rule-based projection from current trends — not probabilistic forecasting.",
  };
}

function buildActionPlan(doc) {
  const immediate = [];
  const midTerm = [];

  const recs = doc.recommendations || [];
  for (const rec of recs) {
    const entry = {
      action: rec.action,
      confidence: rec.confidence || "MEDIUM",
      priority: rec.priority,
    };
    if (
      rec.mapsTo === "client_no_property" ||
      rec.mapsTo === "stuck_pipeline" ||
      rec.mapsTo === "inconsistent_followups" ||
      rec.priority <= 3
    ) {
      immediate.push(entry);
    } else {
      midTerm.push(entry);
    }
  }

  const backlog = doc.lifecycleDropoffs?.clientsNoPropertyAfterConvert || 0;
  if (backlog >= 3 && !immediate.some((a) => a.action.includes("property"))) {
    immediate.unshift({
      action: `Assign FE-Property team to all ${backlog} converted clients without property links within 7 days.`,
      confidence: "HIGH",
      priority: 0,
    });
  }

  const critical = (doc.atRiskOpportunities || []).filter((o) => o.riskLevel === "CRITICAL");
  if (critical.length > 0) {
    immediate.push({
      action: `Escalate ${critical.length} critical stagnant opportunity(ies) — manager review within 48h.`,
      confidence: "HIGH",
      priority: 1,
    });
  }

  if (!midTerm.some((a) => a.action.includes("response"))) {
    midTerm.push({
      action: "Reduce first-response SLA to under 2 hours for new lead assignments.",
      confidence: "MEDIUM",
      priority: 10,
    });
  }

  if (!midTerm.some((a) => a.action.includes("inactive"))) {
    midTerm.push({
      action: "Introduce manager escalation for Hot/High priority leads inactive 7+ days.",
      confidence: "MEDIUM",
      priority: 11,
    });
  }

  return {
    immediate: immediate.slice(0, 5),
    midTerm: midTerm.slice(0, 4),
  };
}

function buildTrendTimeline(kpiHistory, period) {
  if (!kpiHistory?.length) return { periods: [], metrics: [] };

  const sorted = [...kpiHistory].sort(
    (a, b) => new Date(a.periodEnd) - new Date(b.periodEnd)
  );

  const periods = sorted.map((row) => ({
    periodEnd: row.periodEnd,
    label: new Date(row.periodEnd).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
    }),
  }));

  const metricDefs = [
    { key: "leadToClientConversion", label: "Lead conversion rate", format: "pct" },
    { key: "efficiencyScore", label: "Efficiency score", format: "number" },
    { key: "overdueTasks", label: "Overdue tasks", format: "number" },
    { key: "stuckDeals", label: "Stuck deals", format: "number" },
  ];

  const metrics = metricDefs.map((def) => ({
    key: def.key,
    label: def.label,
    format: def.format,
    values: sorted.map((row) => {
      const v = row.metrics?.[def.key];
      return def.format === "pct" && v != null ? roundPct(v * 100) : v;
    }),
    latest: sorted[sorted.length - 1]?.metrics?.[def.key],
    momentum: trendArrow(
      sorted[sorted.length - 1]?.metrics?.[def.key],
      sorted[sorted.length - 2]?.metrics?.[def.key]
    ),
  }));

  return { periods, metrics, periodType: period };
}

function buildComparativeContext(doc, snapshot) {
  const { current, previous, teamBenchmarks } = snapshot;
  const rows = [];

  const conv = current.leadToClientConversion;
  const teamConv = teamBenchmarks?.avgLeadConversion ?? null;
  rows.push({
    metric: "Lead-to-client conversion",
    current: conv != null ? `${roundPct(conv * 100)}%` : "—",
    priorPeriod: previous.leadToClientConversion != null
      ? `${roundPct(previous.leadToClientConversion * 100)}%`
      : "—",
    teamBenchmark:
      teamConv != null ? `${roundPct(teamConv * 100)}%` : "Team avg",
    target: "15%+",
    unit: "rate",
  });

  const resp = current.responseTimeHours;
  rows.push({
    metric: "First response time",
    current: resp != null ? `${resp}h` : "—",
    priorPeriod:
      previous.responseTimeHours != null ? `${previous.responseTimeHours}h` : "—",
    teamBenchmark: `${TEAM_RESPONSE_BENCHMARK}h`,
    target: `${RESPONSE_TARGET_HOURS}h`,
    unit: "hours",
  });

  const completion = normalizeRateToRatio(current.tasks?.company?.completionRate);
  const prevCompletion = normalizeRateToRatio(previous.tasks?.company?.completionRate);
  const teamCompletion = teamBenchmarks?.avgCompletionRate ?? 0.7;
  rows.push({
    metric: "Follow-up completion",
    current: formatRatePct(completion),
    priorPeriod: formatRatePct(prevCompletion),
    teamBenchmark: formatRatePct(teamCompletion),
    target: "80%+",
    unit: "rate",
  });

  const endToEnd = current.lifecycle?.chain?.cohort?.endToEndRate;
  rows.push({
    metric: "End-to-end (lead → opportunity)",
    current: endToEnd != null ? `${roundPct(endToEnd * 100)}%` : "—",
    priorPeriod:
      previous.lifecycle?.chain?.cohort?.endToEndRate != null
        ? `${roundPct(previous.lifecycle.chain.cohort.endToEndRate * 100)}%`
        : "—",
    teamBenchmark: "—",
    target: "25%+",
    unit: "rate",
  });

  const tatRows = doc.crmReportMetrics?.companyTat || [];
  for (const t of tatRows.filter((r) => r.count > 0).slice(0, 3)) {
    rows.push({
      metric: `TAT: ${t.metric}`,
      current: t.averageDays != null ? `${t.averageDays}d` : "—",
      priorPeriod: "—",
      teamBenchmark: `${t.benchmarkDays}d SLA`,
      target: `≤${t.benchmarkDays}d`,
      unit: "days",
      exceedsBenchmark: t.exceedsBenchmark,
    });
  }

  return rows;
}

function buildLeakageIntelligence(doc) {
  const rows = [];
  const dropoffs = doc.lifecycleDropoffs || {};

  if (dropoffs.clientsNoPropertyAfterConvert > 0) {
    rows.push({
      type: "Converted client, no property link",
      count: dropoffs.clientsNoPropertyAfterConvert,
      scope: "company_backlog",
      impact: estimateBlockedPipeline(dropoffs.clientsNoPropertyAfterConvert),
    });
  }

  if (dropoffs.clientsNoOpportunityAfterLink > 0) {
    rows.push({
      type: "Property linked, no opportunity",
      count: dropoffs.clientsNoOpportunityAfterLink,
      scope: "company_backlog",
      impact: estimateBlockedPipeline(dropoffs.clientsNoOpportunityAfterLink),
    });
  }

  if (dropoffs.period?.stillNoProperty > 0) {
    rows.push({
      type: "This period conversions still unlinked",
      count: dropoffs.period.stillNoProperty,
      scope: "this_period",
      impact: estimateBlockedPipeline(dropoffs.period.stillNoProperty),
    });
  }

  const stuck = doc.stuckDeals?.count || doc.pipelineInventory?.stuckCount || 0;
  if (stuck > 0) {
    rows.push({
      type: "Stagnant pipeline opportunities (7+ days inactive)",
      count: stuck,
      scope: "pipeline",
      impact: null,
    });
  }

  const inactive = doc.flags?.find((f) => f.id === "HIGH_INTENT_INACTIVE");
  if (inactive?.value) {
    rows.push({
      type: "Hot/High priority leads inactive",
      count: inactive.value,
      scope: "leads",
      impact: null,
    });
  }

  return rows;
}

function buildTeamComparison(doc, snapshot) {
  const { current, previous, teamBenchmarks } = snapshot;
  const taskByUser = current.tasks?.byUser || [];
  const prevVolumes = previous?.employeeVolumes || [];
  const teamAvgLeads =
    current.employeeVolumes?.length
      ? current.employeeVolumes.reduce((s, e) => s + e.leadsHandled, 0) /
        current.employeeVolumes.length
      : 0;
  const teamAvgConv =
    current.employeeVolumes?.length
      ? current.employeeVolumes.reduce(
          (s, e) => s + safeRatio(e.leadsConverted, e.leadsHandled),
          0
        ) / current.employeeVolumes.length
      : 0;

  const rows = [];

  for (const vol of current.employeeVolumes || []) {
    const taskRow = taskByUser.find(
      (u) => String(u.employee?._id || u.employee) === String(vol.userId)
    );
    const prevVol = prevVolumes.find((e) => String(e.userId) === String(vol.userId));
    const highlight = (doc.employeeHighlights || []).find(
      (h) => String(h.userId) === String(vol.userId)
    );

    const convRate = safeRatio(vol.leadsConverted, vol.leadsHandled);
    const overdue = taskRow?.overdue ?? 0;
    const completion = normalizeRateToRatio(taskRow?.completionRate);
    const efficiency = highlight?.efficiencyScore ?? doc.scores?.efficiencyScore ?? 50;

    let riskLevel = "LOW";
    if (overdue >= 8 || (completion != null && completion < 0.4)) riskLevel = "HIGH";
    else if (overdue >= 4 || convRate < teamAvgConv * 0.6) riskLevel = "MEDIUM";

    rows.push({
      userId: vol.userId,
      name: vol.name,
      role: vol.role,
      efficiencyScore: Math.round(efficiency),
      pipelineHealth: doc.scores?.subScores?.pipelineHealth,
      slaScore: doc.scores?.subScores?.sla,
      followUpScore:
        completion != null ? Math.round(completion * 1000) / 10 : null,
      riskLevel,
      leadsHandled: vol.leadsHandled,
      leadsConverted: vol.leadsConverted,
      conversionRate: roundPct(convRate * 100),
      overdueTasks: overdue,
      opportunitiesLinked: vol.opportunitiesLinked,
      leadsTrend: trendArrow(vol.leadsHandled, prevVol?.leadsHandled),
      conversionTrend: trendArrow(convRate, safeRatio(prevVol?.leadsConverted, prevVol?.leadsHandled)),
    });
  }

  rows.sort((a, b) => b.efficiencyScore - a.efficiencyScore);

  const mainDifference =
    rows.length >= 2
      ? (() => {
          const highOverdue = rows.filter((r) => r.overdueTasks >= 5);
          if (highOverdue.length >= 2) {
            const avgOverdue =
              rows.reduce((s, r) => s + r.overdueTasks, 0) / rows.length;
            const topOverdue = highOverdue[0].overdueTasks;
            if (topOverdue > avgOverdue * 2) {
              return `${highOverdue[0].name} carries ${topOverdue}x the team average overdue burden — primary accountability gap.`;
            }
          }
          const lowConv = rows.filter((r) => r.conversionRate < teamAvgConv * 100 * 0.5);
          if (lowConv.length > 0) {
            return `${lowConv[0].name} conversion (${lowConv[0].conversionRate}%) trails team average (${roundPct(teamAvgConv * 100)}%).`;
          }
          return null;
        })()
      : null;

  return {
    rows,
    teamAverages: {
      leadsHandled: Math.round(teamAvgLeads),
      conversionRate: roundPct(teamAvgConv * 100),
      followUpCompletion: roundPct(
        (teamBenchmarks?.avgCompletionRate ?? 0.7) * 100
      ),
    },
    mainDifference,
  };
}

function buildEmployeeIntelligenceReports(doc, snapshot, teamComparison) {
  const { current, previous, teamBenchmarks } = snapshot;
  const taskByUser = current.tasks?.byUser || [];
  const prevVolumes = previous?.employeeVolumes || [];
  const teamRow = teamComparison;

  return (doc.employeeHighlights || []).map((h) => {
    const vol = current.employeeVolumes?.find((e) => String(e.userId) === String(h.userId));
    const prevVol = prevVolumes.find((e) => String(e.userId) === String(h.userId));
    const taskRow = taskByUser.find(
      (u) => String(u.employee?._id || u.employee) === String(h.userId)
    );
    const teamRowData = teamRow.rows?.find((r) => String(r.userId) === String(h.userId));

    const convRate = vol ? safeRatio(vol.leadsConverted, vol.leadsHandled) : 0;
    const teamConv = teamRow.teamAverages?.conversionRate || 0;
    const overdue = taskRow?.overdue ?? 0;
    const completion = normalizeRateToRatio(taskRow?.completionRate);
    const teamCompletion = teamBenchmarks?.avgCompletionRate ?? 0.7;

    const performanceSnapshot = [
      {
        metric: "Leads handled",
        current: vol?.leadsHandled ?? 0,
        teamAvg: teamRow.teamAverages?.leadsHandled ?? 0,
        trend: trendArrow(vol?.leadsHandled, prevVol?.leadsHandled),
      },
      {
        metric: "Conversion rate",
        current: `${roundPct(convRate * 100)}%`,
        teamAvg: `${teamConv}%`,
        trend: trendArrow(convRate, safeRatio(prevVol?.leadsConverted, prevVol?.leadsHandled)),
      },
      {
        metric: "Follow-up completion",
        current: formatRatePct(completion),
        teamAvg: formatRatePct(teamCompletion),
        trend: trendArrow(completion, null),
      },
      {
        metric: "Overdue tasks",
        current: overdue,
        teamAvg: "—",
        trend: trendArrow(overdue, null),
      },
      {
        metric: "Opportunities linked",
        current: vol?.opportunitiesLinked ?? 0,
        teamAvg: "—",
        trend: trendArrow(vol?.opportunitiesLinked, prevVol?.opportunitiesLinked),
      },
    ];

    const behavioralInsights = [];
    if (overdue >= 5) {
      behavioralInsights.push("Recurring overdue follow-up pattern detected");
    }
    if (vol?.leadsHandled > 5 && vol.leadsConverted === 0) {
      behavioralInsights.push("High lead volume with zero conversions — qualification or follow-up gap");
    }
    if (convRate < teamConv / 100 * 0.6 && vol?.leadsHandled >= 3) {
      behavioralInsights.push("Conversion rate significantly below team average");
    }
    if (h.bottleneck) {
      behavioralInsights.push(h.bottleneck);
    }
    for (const issue of h.issues || []) {
      if (!behavioralInsights.includes(issue)) behavioralInsights.push(issue);
    }

    const strengthAreas = [];
    if (completion != null && completion >= teamCompletion) {
      strengthAreas.push("Follow-up completion at or above team average");
    }
    if (vol && vol.leadsHandled > teamRow.teamAverages?.leadsHandled) {
      strengthAreas.push("High lead handling volume");
    }
    if (convRate >= teamConv / 100 * 1.1) {
      strengthAreas.push("Conversion rate above team average");
    }

    const coachingActions = [];
    if (overdue >= 3) {
      coachingActions.push("Clear overdue tasks daily — target zero overdue by end of week");
    }
    if (convRate < teamConv / 100 * 0.7 && vol?.leadsHandled >= 3) {
      coachingActions.push("Review lead qualification and conversion playbook with manager");
    }
    if (h.bottleneck?.includes("response")) {
      coachingActions.push("Reduce first response below 2h for new assignments");
    }
    if (h.bottleneck?.includes("proposal")) {
      coachingActions.push("Schedule follow-up within 24h after proposal send");
    }
    if (coachingActions.length === 0) {
      coachingActions.push("Maintain current discipline — monitor weekly trend");
    }

    const summaryParts = [];
    if (vol?.leadsHandled > teamRow.teamAverages?.leadsHandled) {
      summaryParts.push(`${h.name} handled elevated lead volume`);
    } else {
      summaryParts.push(`${h.name} operated at ${vol?.leadsHandled ?? 0} leads this period`);
    }
    if (overdue >= 5) {
      summaryParts.push("with declining follow-up discipline");
    } else if (completion != null && completion < teamCompletion) {
      summaryParts.push("with follow-up completion below team norm");
    }
    if (h.bottleneck) {
      summaryParts.push(`Main bottleneck: ${h.bottleneck.toLowerCase()}`);
    }

    const tatRow = doc.crmReportMetrics?.employeeTat?.find(
      (t) => String(t.userId) === String(h.userId)
    );

    if (tatRow?.leadToClient?.exceedsBenchmark) {
      behavioralInsights.push(
        `Lead→Client TAT ${tatRow.leadToClient.averageDays}d vs ${tatRow.leadToClient.benchmarkDays}d SLA`
      );
    }
    if (tatRow?.clientToOpportunity?.exceedsBenchmark) {
      behavioralInsights.push(
        `Client→Opportunity TAT ${tatRow.clientToOpportunity.averageDays}d vs ${tatRow.clientToOpportunity.benchmarkDays}d SLA`
      );
    }

    return {
      userId: h.userId,
      name: h.name,
      role: h.role,
      executiveSummary: summaryParts.join(" — ") + ".",
      efficiencyScore: teamRowData?.efficiencyScore ?? h.efficiencyScore,
      riskLevel: teamRowData?.riskLevel ?? "MEDIUM",
      tatMetrics: tatRow
        ? {
            leadToClient: tatRow.leadToClient,
            clientToOpportunity: tatRow.clientToOpportunity,
          }
        : null,
      performanceSnapshot,
      behavioralInsights: behavioralInsights.slice(0, 5),
      recurringPatterns: h.recurringPatterns || [],
      strengthAreas: strengthAreas.slice(0, 3),
      issues: h.issues || [],
      coachingActions: coachingActions.slice(0, 4),
    };
  });
}

/**
 * Build full executive report envelope for UI.
 */
function buildExecutiveReport(doc, snapshot, kpiHistoryRows, reportId) {
  snapshot.kpiHistoryLength = kpiHistoryRows?.length || 0;
  snapshot.kpiHistory = kpiHistoryRows || [];

  const keyFindings = buildKeyFindings(doc, snapshot);
  const teamComparison = buildTeamComparison(doc, snapshot);
  const employeeIntelligence = buildEmployeeIntelligenceReports(doc, snapshot, teamComparison);

  const period = snapshot.meta?.period || doc.meta?.period || "weekly";

  return {
    meta: buildReportMeta(doc, reportId, period),
    confidence: buildConfidence(doc, snapshot),
    executiveBrief: buildExecutiveBrief(doc, snapshot, keyFindings),
    keyFindings,
    synthesis: buildSynthesis(doc, snapshot),
    businessImpact: buildBusinessImpact(doc, snapshot),
    forecast: buildForecast(doc, snapshot, kpiHistoryRows || []),
    actionPlan: buildActionPlan(doc),
    trendTimeline: buildTrendTimeline(kpiHistoryRows, period),
    comparativeContext: buildComparativeContext(doc, snapshot),
    leakageIntelligence: buildLeakageIntelligence(doc),
    teamComparison,
    employeeIntelligence,
    crmReportMetrics: doc.crmReportMetrics || null,
    chapters: [
      { id: "overview", number: 1, title: "Executive Overview" },
      { id: "operations", number: 2, title: "Operational Intelligence" },
      { id: "team", number: 3, title: "Team Performance" },
      { id: "risk", number: 4, title: "Risks & Forecast" },
      { id: "actions", number: 5, title: "Recommended Actions" },
    ],
  };
}

module.exports = {
  buildExecutiveReport,
  buildKeyFindings,
  buildEmployeeIntelligenceReports,
};
