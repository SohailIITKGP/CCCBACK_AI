/**
 * Presentation layer — enriches InsightDocument for enterprise UI
 * (revenue proxies, attention items, score breakdowns, audit intelligence).
 */

const REVENUE_PER_CLIENT_LAKHS = parseFloat(
  process.env.INSIGHTS_REVENUE_PER_CLIENT_LAKHS || "3",
  10
);

function formatLakhs(low, high) {
  const l = Math.round(low);
  const h = Math.round(high);
  return `₹${l}–${h}L`;
}

function estimateBlockedPipeline(clientCount) {
  if (!clientCount || clientCount <= 0) return null;
  const low = clientCount * REVENUE_PER_CLIENT_LAKHS * 0.75;
  const high = clientCount * REVENUE_PER_CLIENT_LAKHS * 1.25;
  return {
    clientCount,
    rangeLakhs: { low, high },
    label: formatLakhs(low, high),
    disclaimer: "Estimated blocked pipeline (configurable proxy per client)",
  };
}

function momentumArrow(deltaPct) {
  if (deltaPct == null) return { arrow: "→", label: "stable", class: "stable" };
  if (deltaPct > 3) return { arrow: "↑", label: "improving", class: "up" };
  if (deltaPct < -3) return { arrow: "↓", label: "worsening", class: "down" };
  return { arrow: "→", label: "stable", class: "stable" };
}

function buildScoreBreakdowns(doc) {
  const inv = doc.pipelineInventory || {};
  const stuck = inv.stuckCount || doc.stuckDeals?.count || 0;
  const total = inv.totalInPipeline || 0;
  const overdue = doc.funnel?.current ? null : null;
  const taskOverdue = doc.flags?.find((f) => f.id === "OVERDUE_TASK_SPIKE")?.value;

  const sub = doc.scores?.subScores || {};

  return {
    pipelineHealth: {
      score: sub.pipelineHealth,
      reasons: [
        total > 0
          ? `${stuck} of ${total} pipeline opportunities inactive ${inv.thresholdDays || 7}+ days (${Math.round((stuck / total) * 100)}%)`
          : "No active pipeline inventory",
        stuck > 0 ? "No recent stage movement on stuck deals" : "Pipeline moving",
      ],
    },
    followUpDiscipline: {
      score: sub.followUpDiscipline,
      reasons: [
        sub.followUpDiscipline < 40
          ? "High overdue follow-up task count"
          : "Follow-up completion within acceptable range",
        doc.problems?.some((p) => p.id === "inconsistent_followups")
          ? "Task completion below team average"
          : null,
      ].filter(Boolean),
    },
    sla: {
      score: sub.sla,
      reasons: [
        sub.sla >= 80 ? "TAT and response metrics near benchmark" : "TAT breaches or slow first response",
      ],
    },
    velocity: {
      score: sub.velocity,
      reasons: [
        doc.headline?.direction === "down"
          ? `Lead conversion ${formatPct(doc.headline?.deltaPct)} vs prior period`
          : "Conversion velocity stable or improving",
      ],
    },
    engagement: {
      score: sub.engagement,
      reasons: [
        doc.auditLifecycle?.totalEvents > 0
          ? `${doc.auditLifecycle.totalEvents} audited lifecycle events this period`
          : "Limited CRM activity logged",
      ],
    },
  };
}

function formatPct(v) {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v}%`;
}

function buildAuditIntelligence(auditLifecycle, funnelDelta) {
  if (!auditLifecycle) return null;

  const entries = Object.entries(auditLifecycle.byResource || {})
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1]);

  const insights = [];
  if (entries[0]) {
    insights.push(`Most workflow activity: ${entries[0][0]} (${entries[0][1]} audited events)`);
  }
  if (auditLifecycle.leadConversionEvents > 0) {
    insights.push(`${auditLifecycle.leadConversionEvents} lead→client conversions logged in audit trail`);
  }
  if (auditLifecycle.linkPropertyEvents > 0) {
    insights.push(`${auditLifecycle.linkPropertyEvents} property link → opportunity events`);
  }
  if (entries.length > 1) {
    const lowest = entries[entries.length - 1];
    insights.push(`Lowest operational movement: ${lowest[0]} (${lowest[1]} events)`);
  }

  const leadsDelta = funnelDelta?.leadsConverted;
  let velocityNote = "Workflow velocity stable this period";
  if (leadsDelta != null && leadsDelta < -15) {
    velocityNote = "Workflow velocity slowed after lead conversion stage";
  } else if (auditLifecycle.fieldChanges < 3) {
    velocityNote = "Low field-level updates — pipeline may be stagnant";
  }

  return {
    insights,
    velocityNote,
    excludesMiddleware: true,
  };
}

function buildManagerAttention(doc) {
  const items = [];
  const dropoffs = doc.lifecycleDropoffs || {};
  const backlog = dropoffs.clientsNoPropertyAfterConvert || 0;

  if (backlog >= 3) {
    const rev = estimateBlockedPipeline(backlog);
    items.push({
      severity: "critical",
      icon: "leakage",
      title: `${backlog} converted clients not property-linked`,
      detail: `${dropoffs.thresholdDays}+ days without property assignment`,
      revenue: rev,
    });
  }

  const critical = (doc.atRiskOpportunities || []).filter(
    (o) => o.riskLevel === "CRITICAL" || o.riskScore >= 80
  );
  if (critical.length > 0) {
    items.push({
      severity: "critical",
      icon: "risk",
      title: `${critical.length} critical stagnant opportunity(ies)`,
      detail: critical[0].clientName + ` — ${critical[0].daysStuck} days stuck`,
    });
  }

  const followScore = doc.scores?.subScores?.followUpDiscipline;
  if (followScore != null && followScore < 40) {
    items.push({
      severity: "warning",
      icon: "tasks",
      title: "Follow-up discipline below threshold",
      detail: `Score ${followScore}/100 — overdue tasks accumulating`,
    });
  }

  if (dropoffs.period?.stillNoProperty > 0) {
    items.push({
      severity: "warning",
      icon: "chain",
      title: `${dropoffs.period.stillNoProperty} conversions this period still unlinked`,
      detail: "Property assignment pending after client conversion",
      revenue: estimateBlockedPipeline(dropoffs.period.stillNoProperty),
    });
  }

  if (doc.headline?.direction === "down" && doc.headline?.deltaPct <= -10) {
    items.push({
      severity: "warning",
      icon: "conversion",
      title: "Lead conversion declining",
      detail: doc.headline.sentence,
    });
  }

  return items.slice(0, 6);
}

function buildExtendedPipelineFunnelVisual(extendedFunnel) {
  if (!extendedFunnel?.length) return null;

  const steps = extendedFunnel.map((s) => ({
    key: s.key,
    label: s.label,
    count: s.count,
    rateLabel: s.ratio != null ? `${s.ratio}%` : null,
  }));

  return { steps, source: "admin_dashboard_funnel" };
}

function buildLifecycleFunnelVisual(chain) {
  if (!chain?.steps?.length) return null;

  const byKey = {};
  for (const s of chain.steps) byKey[s.key] = s;

  const leads = byKey.lead_created?.count ?? 0;
  const converted = byKey.lead_to_client?.count ?? chain.cohort?.leadsConverted ?? 0;
  const withProperty = byKey.client_to_property?.count ?? chain.cohort?.clientsWithPropertyLink ?? 0;
  const withOpp =
    byKey.client_to_opportunity?.count ?? chain.cohort?.clientsWithOpportunity ?? 0;

  const steps = [
    {
      key: "leads",
      label: "Leads",
      count: leads,
      rate: null,
      rateLabel: null,
    },
    {
      key: "clients",
      label: "Clients",
      count: converted,
      rate: leads > 0 ? converted / leads : 0,
      rateLabel: leads > 0 ? `${Math.round((converted / leads) * 100)}%` : null,
    },
    {
      key: "property",
      label: "Property linked",
      count: withProperty,
      rate: converted > 0 ? withProperty / converted : 0,
      rateLabel: converted > 0 ? `${Math.round((withProperty / converted) * 100)}%` : null,
    },
    {
      key: "opportunity",
      label: "Opportunities",
      count: withOpp,
      rate: converted > 0 ? withOpp / converted : 0,
      rateLabel: converted > 0 ? `${Math.round((withOpp / converted) * 100)}%` : null,
    },
  ];

  return { steps, endToEndRate: chain.cohort?.endToEndRate };
}

function enhanceAtRiskOpportunities(atRisk) {
  return (atRisk || []).map((row) => {
    const reasons = [];
    if (row.daysStuck >= 7) reasons.push(`No update for ${row.daysStuck} days`);
    if (row.reasons?.includes("proposal_sent_no_progress")) {
      reasons.push("Proposal sent without progression");
    }
    for (const r of row.reasons || []) {
      if (r.includes("overdue_followups")) {
        reasons.push(r.replace(/_/g, " "));
      }
    }
    if (row.status?.toLowerCase().includes("negotiate")) {
      reasons.push("Stalled in negotiation");
    }
    if (!reasons.length) reasons.push("Inactive in pipeline");

    let suggestedAction = "Schedule follow-up within 24 hours";
    if (row.daysStuck > 90) suggestedAction = "Escalate to manager or archive if dead";
    else if (row.daysStuck > 30) suggestedAction = "Escalate — assign recovery owner";
    else if (row.proposalSent) suggestedAction = "Call client — confirm proposal status";

    return {
      ...row,
      riskReasons: reasons.slice(0, 4),
      suggestedAction,
    };
  });
}

function buildExecutiveNarrative(doc) {
  const bullets = [];
  const headline = doc.headline;

  if (headline?.direction === "down") {
    bullets.push(
      `Lead conversion dropped ${Math.abs(headline.deltaPct || 0)}% despite ${doc.funnel?.deltaPct?.leadsCreated > 0 ? "healthy lead inflow" : "current lead volume"}.`
    );
  } else if (headline?.direction === "up") {
    bullets.push(headline.sentence);
  } else {
    bullets.push("Lead conversion remained stable this period.");
  }

  const backlog = doc.lifecycleDropoffs?.clientsNoPropertyAfterConvert;
  if (backlog >= 3) {
    bullets.push(
      `Main issue is workflow leakage after client conversion: ${backlog} converted clients remain unlinked to properties for ${doc.lifecycleDropoffs?.thresholdDays || 7}+ days.`
    );
  }

  if (doc.mainBottleneck?.label) {
    bullets.push(`Operational bottleneck: ${doc.mainBottleneck.label}.`);
  }

  if (doc.scores?.subScores?.followUpDiscipline < 50) {
    bullets.push(
      "Inconsistent follow-ups and overdue tasks continue to reduce pipeline velocity."
    );
  }

  if (doc.auditIntelligence?.velocityNote) {
    bullets.push(doc.auditIntelligence.velocityNote + ".");
  }

  bullets.push(
    `Efficiency score ${doc.scores?.efficiencyScore}/100 (${doc.scores?.riskLevel} risk).`
  );

  return bullets.slice(0, 5);
}

function buildTrendIndicators(doc) {
  const d = doc.funnel?.deltaPct || {};
  return [
    {
      label: "Lead conversion",
      ...momentumArrow(doc.headline?.deltaPct),
    },
    {
      label: "Leads created",
      ...momentumArrow(d.leadsCreated),
    },
    {
      label: "Pipeline wins",
      ...momentumArrow(d.wins),
    },
    {
      label: "Client engagement",
      ...momentumArrow(doc.funnel?.deltaPct?.auditActivityPct ?? null),
    },
    {
      label: "Follow-up discipline",
      ...momentumArrow(
        doc.scores?.subScores?.followUpDiscipline < 40 ? -20 : doc.scores?.subScores?.followUpDiscipline > 60 ? 10 : 0
      ),
    },
  ];
}

/**
 * Enrich assembled document with presentation fields for UI.
 */
function enrichInsightDocument(doc, opportunityAging) {
  try {
    return enrichInsightDocumentInner(doc, opportunityAging);
  } catch (err) {
    console.error("[insightPresentation] enrich failed, using base document:", err.message);
    return { ...doc, opportunityAging: opportunityAging || doc.opportunityAging };
  }
}

function enrichInsightDocumentInner(doc, opportunityAging) {
  const enriched = { ...doc };

  enriched.lifecycleFunnel = buildLifecycleFunnelVisual(doc.lifecycleChain);
  enriched.extendedPipelineFunnel = buildExtendedPipelineFunnelVisual(
    doc.crmReportMetrics?.extendedFunnel
  );
  enriched.crmReportMetrics = doc.crmReportMetrics || null;
  enriched.scoreBreakdowns = buildScoreBreakdowns(doc);
  enriched.auditIntelligence = buildAuditIntelligence(
    doc.auditLifecycle,
    doc.funnel?.deltaPct
  );
  enriched.managerAttention = buildManagerAttention(doc);
  enriched.atRiskOpportunities = enhanceAtRiskOpportunities(doc.atRiskOpportunities);
  enriched.opportunityAging = opportunityAging || doc.opportunityAging;

  const backlog = doc.lifecycleDropoffs?.clientsNoPropertyAfterConvert || 0;
  enriched.revenueImpact = {
    workflowLeakage: estimateBlockedPipeline(backlog),
    periodLeakage: estimateBlockedPipeline(doc.lifecycleDropoffs?.period?.stillNoProperty || 0),
  };

  enriched.workflowLeakageAlert =
    backlog >= 3
      ? {
          severity: "critical",
          title: "Workflow leakage detected",
          message: `${backlog} converted clients have no property linked for ${doc.lifecycleDropoffs?.thresholdDays || 7}+ days.`,
          revenue: enriched.revenueImpact.workflowLeakage,
        }
      : null;

  enriched.trendIndicators = buildTrendIndicators(doc);
  enriched.narrative = {
    ...doc.narrative,
    executiveSummary: buildExecutiveNarrative({
      ...doc,
      auditIntelligence: enriched.auditIntelligence,
    }),
    polishedByAI: false,
  };

  return enriched;
}

module.exports = {
  enrichInsightDocument,
  estimateBlockedPipeline,
};
