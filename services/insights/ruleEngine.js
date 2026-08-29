const STUCK_DEALS_THRESHOLD = parseInt(process.env.INSIGHTS_STUCK_DEALS_COUNT || "5", 10);

/**
 * Deterministic flags from metrics — no AI.
 */
function runRuleEngine(snapshot) {
  const flags = [];
  const { current, previous, deltas } = snapshot;

  const overdueCurrent = current.tasks?.company?.overdue || 0;
  const overduePrevious = previous.tasks?.company?.overdue || 0;

  if (overduePrevious > 0 && overdueCurrent > overduePrevious * 1.3) {
    flags.push({
      id: "OVERDUE_TASK_SPIKE",
      severity: "HIGH",
      value: overdueCurrent,
      threshold: Math.ceil(overduePrevious * 1.3),
      label: "Overdue task spike",
    });
  }

  const stuckCount = current.stuckDeals?.count || 0;
  if (stuckCount >= STUCK_DEALS_THRESHOLD) {
    flags.push({
      id: "STUCK_PIPELINE",
      severity: "HIGH",
      value: stuckCount,
      threshold: STUCK_DEALS_THRESHOLD,
      label: "Multiple stuck pipeline deals",
    });
  }

  const convDelta = deltas?.leadToClientConversionPct;
  if (convDelta != null && convDelta <= -15) {
    flags.push({
      id: "FUNNEL_DROP",
      severity: "HIGH",
      value: convDelta,
      threshold: -15,
      label: "Lead conversion drop",
    });
  }

  const responseDelta = deltas?.responseTimeHoursPct;
  if (responseDelta != null && responseDelta >= 30) {
    flags.push({
      id: "SLOW_RESPONSE",
      severity: "HIGH",
      value: responseDelta,
      threshold: 30,
      label: "Response time increase",
    });
  }

  const tatBreaches = current.tatBreaches || 0;
  if (tatBreaches >= 5) {
    flags.push({
      id: "TAT_BREACH_LEAD_CLIENT",
      severity: "MEDIUM",
      count: tatBreaches,
      threshold: 5,
      label: "Lead-to-client TAT breaches",
    });
  }

  const inactiveHighIntent = current.highIntentInactive?.count || 0;
  const inactivePrev = previous.highIntentInactive?.count || 0;
  if (inactiveHighIntent > inactivePrev && inactiveHighIntent >= 10) {
    flags.push({
      id: "HIGH_INTENT_INACTIVE",
      severity: "HIGH",
      value: inactiveHighIntent,
      threshold: inactivePrev,
      label: "Hot/High leads inactive",
    });
  }

  const proposalFollowDelta = deltas?.proposalFollowUpRatePct;
  if (proposalFollowDelta != null && proposalFollowDelta <= -20) {
    flags.push({
      id: "PROPOSAL_FOLLOWUP_DROP",
      severity: "MEDIUM",
      value: proposalFollowDelta,
      threshold: -20,
      label: "Proposal follow-up drop",
    });
  }

  const dropoffs = current.lifecycle?.dropoffs;
  if (dropoffs?.clientsNoPropertyAfterConvert >= 5) {
    flags.push({
      id: "CLIENT_NO_PROPERTY_LINK",
      severity: "HIGH",
      value: dropoffs.clientsNoPropertyAfterConvert,
      threshold: 5,
      label: "Clients converted but no property linked",
    });
  }

  const clientToOppDelta = deltas?.clientToOpportunityRatePct;
  if (clientToOppDelta != null && clientToOppDelta <= -20) {
    flags.push({
      id: "CHAIN_STALL_CLIENT_TO_OPP",
      severity: "HIGH",
      value: clientToOppDelta,
      threshold: -20,
      label: "Client → opportunity chain slowing",
    });
  }

  return flags;
}

module.exports = { runRuleEngine };
