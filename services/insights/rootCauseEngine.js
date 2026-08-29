function buildDriver(metric, label, current, previous, unit, count) {
  const deltaPct =
    previous != null && previous !== 0
      ? Math.round(((current - previous) / previous) * 1000) / 10
      : current > 0
        ? 100
        : 0;

  return {
    factor: metric,
    label,
    current,
    previous,
    unit,
    count,
    deltaPct,
    correlation: null,
    confidence: "MEDIUM",
  };
}

/**
 * Rank contributors when headline metric drops — correlation filled when KpiHistory exists.
 */
function runRootCauseEngine(snapshot, headline) {
  if (!headline || headline.direction !== "down") {
    return [];
  }

  const { current, previous, deltas } = snapshot;
  const drivers = [];

  if (deltas?.responseTimeHoursPct != null) {
    drivers.push({
      ...buildDriver(
        "response_time",
        "Response time after inquiry",
        current.responseTimeHours,
        previous.responseTimeHours,
        "hours"
      ),
      deltaPct: deltas.responseTimeHoursPct,
      correlation: 0.75,
      confidence: deltas.responseTimeHoursPct >= 25 ? "HIGH" : "MEDIUM",
    });
  }

  if (deltas?.proposalFollowUpRatePct != null) {
    drivers.push({
      ...buildDriver(
        "proposal_follow_up",
        "Proposal follow-up completion rate",
        current.proposalFollowUpRate,
        previous.proposalFollowUpRate,
        "ratio"
      ),
      deltaPct: deltas.proposalFollowUpRatePct,
      correlation: 0.65,
      confidence: "MEDIUM",
    });
  }

  const inactiveCurrent = current.highIntentInactive?.count || 0;
  const inactivePrev = previous.highIntentInactive?.count || 0;
  if (inactiveCurrent > inactivePrev) {
    drivers.push({
      factor: "high_intent_inactive",
      label: "Hot/High priority leads inactive (>7 days)",
      count: inactiveCurrent,
      previousCount: inactivePrev,
      deltaPct:
        inactivePrev > 0
          ? Math.round(((inactiveCurrent - inactivePrev) / inactivePrev) * 1000) / 10
          : inactiveCurrent > 0
            ? 100
            : 0,
      correlation: 0.7,
      confidence: "HIGH",
    });
  }

  if (deltas?.overdueTasksPct != null && deltas.overdueTasksPct > 10) {
    drivers.push({
      ...buildDriver(
        "overdue_tasks",
        "Overdue follow-up tasks",
        current.tasks?.company?.overdue,
        previous.tasks?.company?.overdue,
        "count"
      ),
      deltaPct: deltas.overdueTasksPct,
      correlation: 0.72,
      confidence: deltas.overdueTasksPct >= 30 ? "HIGH" : "MEDIUM",
    });
  }

  if (deltas?.clientToPropertyRatePct != null && deltas.clientToPropertyRatePct <= -15) {
    drivers.push({
      factor: "client_to_property_stall",
      label: "Client → property linking slowed",
      current: current.lifecycle?.chain?.cohort?.clientToPropertyRate,
      previous: previous.lifecycle?.chain?.cohort?.clientToPropertyRate,
      deltaPct: deltas.clientToPropertyRatePct,
      correlation: 0.68,
      confidence: "MEDIUM",
    });
  }

  if (deltas?.clientToOpportunityRatePct != null && deltas.clientToOpportunityRatePct <= -15) {
    drivers.push({
      factor: "client_to_opportunity_stall",
      label: "Property link → opportunity creation slowed",
      current: current.lifecycle?.chain?.cohort?.clientToOpportunityRate,
      previous: previous.lifecycle?.chain?.cohort?.clientToOpportunityRate,
      deltaPct: deltas.clientToOpportunityRatePct,
      correlation: 0.7,
      confidence: "HIGH",
    });
  }

  const noProperty = current.lifecycle?.dropoffs?.clientsNoPropertyAfterConvert;
  if (noProperty >= 5) {
    drivers.push({
      factor: "converted_no_property",
      label: "Converted clients without property link (7+ days)",
      count: noProperty,
      confidence: "HIGH",
      deltaPct: null,
    });
  }

  drivers.sort(
    (a, b) =>
      (b.correlation || 0) * Math.abs(b.deltaPct || 0) -
      (a.correlation || 0) * Math.abs(a.deltaPct || 0)
  );

  return drivers.slice(0, 4);
}

function buildHeadline(snapshot) {
  const conv = snapshot.current.leadToClientConversion || 0;
  const prevConv = snapshot.previous.leadToClientConversion || 0;
  const deltaPct =
    prevConv > 0
      ? Math.round(((conv - prevConv) / prevConv) * 1000) / 10
      : conv > 0
        ? 100
        : 0;

  const direction =
    deltaPct > 2 ? "up" : deltaPct < -2 ? "down" : "flat";

  const absDelta = Math.abs(deltaPct);
  const sentence =
    direction === "down"
      ? `Lead to client conversion dropped ${absDelta}% this period`
      : direction === "up"
        ? `Lead to client conversion improved ${absDelta}% this period`
        : `Lead to client conversion remained stable this period`;

  return {
    metric: "lead_to_client_conversion",
    label: "Lead to client conversion",
    current: conv,
    previous: prevConv,
    deltaPct,
    direction,
    sentence,
  };
}

module.exports = { runRootCauseEngine, buildHeadline };
