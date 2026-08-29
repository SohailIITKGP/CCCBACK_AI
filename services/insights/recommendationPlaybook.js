const PLAYBOOK = {
  SLOW_RESPONSE: {
    priority: 1,
    action: "Reduce first response time below 2 hours for new lead assignments",
    mapsTo: "slow_response",
    confidence: "HIGH",
    automatable: true,
    automationType: "notify_assignee_on_new_lead",
  },
  OVERDUE_TASK_SPIKE: {
    priority: 2,
    action: "Enable automated reminder workflows for overdue follow-up tasks",
    mapsTo: "inconsistent_followups",
    confidence: "HIGH",
    automatable: true,
    automationType: "reminder_sweep_escalation",
  },
  PROPOSAL_FOLLOWUP_DROP: {
    priority: 3,
    action: "Schedule follow-up calls within 24h after proposal email sent",
    mapsTo: "proposal_follow_up",
    confidence: "MEDIUM",
    automatable: true,
    automationType: "create_task_on_proposal_sent",
  },
  HIGH_INTENT_INACTIVE: {
    priority: 4,
    action: "Run daily review of Hot/High priority leads with no activity in 7+ days",
    mapsTo: "high_intent_inactive",
    confidence: "HIGH",
    automatable: false,
    automationType: null,
  },
  STUCK_PIPELINE: {
    priority: 5,
    action: "Escalate pipeline deals stuck beyond 7 days — assign manager review",
    mapsTo: "stuck_pipeline",
    confidence: "HIGH",
    automatable: true,
    automationType: "escalate_stuck_deals",
  },
  FUNNEL_DROP: {
    priority: 6,
    action: "Focus team on lead-to-client conversion — pair low performers with top converters",
    mapsTo: "funnel_drop",
    confidence: "MEDIUM",
    automatable: false,
    automationType: null,
  },
  TAT_BREACH_LEAD_CLIENT: {
    priority: 7,
    action: "Tighten lead-to-client SLA — target within 1 business day",
    mapsTo: "tat_breach",
    confidence: "MEDIUM",
    automatable: false,
    automationType: null,
  },
  CLIENT_NO_PROPERTY_LINK: {
    priority: 8,
    action: "Review converted clients with no property linked — assign FE-Property to shortlist options",
    mapsTo: "client_no_property",
    confidence: "HIGH",
    automatable: false,
    automationType: null,
  },
  CHAIN_STALL_CLIENT_TO_OPP: {
    priority: 9,
    action: "Accelerate client–property linking to create opportunities (link flow creates opp automatically)",
    mapsTo: "chain_stall",
    confidence: "HIGH",
    automatable: false,
    automationType: null,
  },
};

function buildRecommendations(flags, problems) {
  const seen = new Set();
  const recommendations = [];

  for (const flag of flags) {
    const entry = PLAYBOOK[flag.id];
    if (!entry || seen.has(entry.mapsTo)) continue;
    seen.add(entry.mapsTo);
    recommendations.push({ ...entry });
  }

  for (const problem of problems || []) {
    if (problem.id === "slow_response" && !seen.has("slow_response")) {
      recommendations.push({ ...PLAYBOOK.SLOW_RESPONSE });
      seen.add("slow_response");
    }
    if (problem.id === "inconsistent_followups" && !seen.has("inconsistent_followups")) {
      recommendations.push({ ...PLAYBOOK.OVERDUE_TASK_SPIKE });
      seen.add("inconsistent_followups");
    }
  }

  return recommendations.sort((a, b) => a.priority - b.priority).slice(0, 5);
}

function buildExpectedImpact(headline, rootCauses, kpiHistoryLength) {
  if (headline.direction !== "down") {
    return {
      metric: "lead_to_client_conversion",
      improvementRangePct: null,
      confidence: "LOW",
      basis: "No conversion decline detected in this period",
      showInUI: false,
    };
  }

  const hasStrongDriver = rootCauses.some(
    (r) => r.confidence === "HIGH" && Math.abs(r.deltaPct || 0) >= 25
  );

  if (kpiHistoryLength >= 4 && hasStrongDriver) {
    return {
      metric: "lead_to_client_conversion",
      improvementRangePct: { low: 12, high: 25 },
      confidence: "MEDIUM",
      basis:
        "When response time and follow-up discipline improved historically, conversion typically recovered 12–25%",
      showInUI: true,
    };
  }

  return {
    metric: "lead_to_client_conversion",
    improvementRangePct: null,
    confidence: "LOW",
    basis: "Insufficient historical data for impact estimate",
    showInUI: false,
  };
}

module.exports = { buildRecommendations, buildExpectedImpact };
