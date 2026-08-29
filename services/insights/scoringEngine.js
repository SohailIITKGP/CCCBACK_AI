function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function scoreFromRate(rate, weight = 100) {
  if (rate == null) return weight * 0.5;
  return clamp(rate * weight);
}

function scoreFromInversePenalty(value, penaltyPerUnit, maxPenalty = 50) {
  const penalty = Math.min(maxPenalty, (value || 0) * penaltyPerUnit);
  return clamp(100 - penalty);
}

/**
 * Compute efficiency and sub-scores from aggregated snapshot.
 */
function runScoringEngine(snapshot) {
  const { current, previous, teamBenchmarks } = snapshot;

  const completionRate = current.tasks?.company?.completionRate;
  const teamCompletion = teamBenchmarks?.avgCompletionRate ?? 0.7;
  const overdue = current.tasks?.company?.overdue || 0;
  const stuckCount =
    current.pipelineInventory?.stuckCount ?? current.stuckDeals?.count ?? 0;
  const pipelineTotal =
    current.pipelineInventory?.totalInPipeline ?? current.funnel?.pipelineCount ?? 0;
  const convRate = current.leadToClientConversion || 0;
  const prevConv = previous?.leadToClientConversion || convRate;
  const responseHours = current.responseTimeHours;
  const benchResponse = teamBenchmarks?.responseTimeHoursP20 ?? 4.2;

  const completionBase =
    completionRate != null ? scoreFromRate(completionRate, 70) : 50;
  const overduePenalty = Math.min(40, overdue * 1.2);
  const followUpDiscipline = clamp(
    completionBase - overduePenalty + (completionRate >= teamCompletion ? 8 : 0)
  );

  const slaScore = clamp(
    100 -
      (current.tatBreaches || 0) * 4 -
      (responseHours && benchResponse
        ? Math.min(40, ((responseHours - benchResponse) / benchResponse) * 20)
        : 0)
  );

  const stuckRatio =
    pipelineTotal > 0 ? stuckCount / pipelineTotal : stuckCount > 0 ? 1 : 0;
  const pipelineHealth = clamp(100 - stuckRatio * 85 - Math.min(15, stuckCount * 0.3));

  const velocityDelta =
    prevConv > 0 ? ((convRate - prevConv) / prevConv) * 100 : convRate > 0 ? 10 : 0;
  const velocity = clamp(60 + velocityDelta * 2);

  const engagementDelta = current.auditEngagement?.deltaPct ?? 0;
  const engagement = clamp(70 + engagementDelta * 0.5);

  const efficiencyScore = clamp(
    slaScore * 0.25 +
      followUpDiscipline * 0.3 +
      pipelineHealth * 0.25 +
      velocity * 0.2
  );

  let riskLevel = "LOW";
  if (efficiencyScore < 60) riskLevel = "HIGH";
  else if (efficiencyScore < 80) riskLevel = "MEDIUM";

  return {
    efficiencyScore,
    riskLevel,
    subScores: {
      sla: clamp(slaScore),
      followUpDiscipline: clamp(followUpDiscipline),
      pipelineHealth: clamp(pipelineHealth),
      velocity: clamp(velocity),
      engagement: clamp(engagement),
    },
  };
}

module.exports = { runScoringEngine };
