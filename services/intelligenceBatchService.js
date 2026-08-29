const { randomUUID } = require("crypto");
const OutcomeTracking = require("../models/OutcomeTracking");
const RuleChangeProposal = require("../models/RuleChangeProposal");
const {
  CONFIG_KEYS,
  DEFAULT_MATCHING_WEIGHTS,
  getActiveConfig,
  applyConfigUpdate,
} = require("./ruleConfigService");

const ANALYSIS_WINDOW_DAYS = 90;
const MIN_SAMPLE_SIZE = 5;
const MAX_WEIGHT_DELTA = 5;

function windowStart(days = ANALYSIS_WINDOW_DAYS) {
  return new Date(Date.now() - days * 86_400_000);
}

function computeWinRate(outcomes) {
  if (!outcomes.length) return 0;
  const wins = outcomes.filter((o) => o.outcome === "won").length;
  return wins / outcomes.length;
}

function groupByTemplate(outcomes) {
  const groups = new Map();
  for (const row of outcomes) {
    const templates = row.followUpTemplatesUsed?.length
      ? row.followUpTemplatesUsed
      : ["unknown"];
    for (const templateId of templates) {
      if (!groups.has(templateId)) groups.set(templateId, []);
      groups.get(templateId).push(row);
    }
  }
  return groups;
}

function buildMatchingProposals(batchId, outcomes, baselineWinRate, currentWeights) {
  const proposals = [];
  if (outcomes.length < MIN_SAMPLE_SIZE) return proposals;

  const won = outcomes.filter((o) => o.outcome === "won");
  const lost = outcomes.filter((o) => o.outcome === "lost");
  if (!won.length || !lost.length) return proposals;

  const avgShown = (rows) => {
    const counts = rows.map((r) => r.propertiesShown?.length || 0);
    return counts.reduce((a, b) => a + b, 0) / Math.max(counts.length, 1);
  };

  const wonAvg = avgShown(won);
  const lostAvg = avgShown(lost);
  const delta = wonAvg - lostAvg;

  if (Math.abs(delta) < 0.5) return proposals;

  const targetKey = delta > 0 ? "location" : "rent";
  const current = currentWeights[targetKey] ?? DEFAULT_MATCHING_WEIGHTS[targetKey];
  const direction = delta > 0 ? 1 : -1;
  const proposed = Math.max(5, Math.min(40, current + direction * MAX_WEIGHT_DELTA));

  if (proposed === current) return proposals;

  proposals.push({
    batchId,
    ruleSet: "matching",
    parameter: targetKey,
    currentValue: current,
    proposedValue: proposed,
    rationale: `Won journeys averaged ${wonAvg.toFixed(1)} suggested properties vs ${lostAvg.toFixed(
      1
    )} for lost. Adjusting "${targetKey}" weight may improve ranking quality.`,
    evidence: {
      sampleSize: outcomes.length,
      winRate: Math.round(computeWinRate(outcomes) * 1000) / 10,
      baselineWinRate: Math.round(baselineWinRate * 1000) / 10,
    },
    status: "pending",
  });

  return proposals;
}

function buildTemplateProposals(batchId, outcomes, baselineWinRate, currentTemplates) {
  const proposals = [];
  const groups = groupByTemplate(outcomes);

  for (const [templateId, rows] of groups.entries()) {
    if (templateId === "unknown" || rows.length < MIN_SAMPLE_SIZE) continue;
    const rate = computeWinRate(rows);
    if (rate <= baselineWinRate + 0.05) continue;

    const coldTemplate = currentTemplates.Cold || "lead_followup_v1";
    if (templateId === coldTemplate) continue;

    proposals.push({
      batchId,
      ruleSet: "follow_up",
      parameter: "Cold",
      currentValue: coldTemplate,
      proposedValue: templateId,
      rationale: `Template "${templateId}" converted at ${Math.round(rate * 100)}% vs baseline ${Math.round(
        baselineWinRate * 100
      )}% (${rows.length} journeys).`,
      evidence: {
        sampleSize: rows.length,
        winRate: Math.round(rate * 1000) / 10,
        baselineWinRate: Math.round(baselineWinRate * 1000) / 10,
      },
      status: "pending",
    });
    break;
  }

  return proposals;
}

function buildLeadScoringProposals(batchId, outcomes, baselineWinRate) {
  const proposals = [];
  const referralRows = outcomes.filter((o) =>
    String(o.leadSource || "").toLowerCase().includes("referral")
  );
  if (referralRows.length < MIN_SAMPLE_SIZE) return proposals;

  const referralRate = computeWinRate(referralRows);
  if (referralRate <= baselineWinRate + 0.08) return proposals;

  proposals.push({
    batchId,
    ruleSet: "lead_scoring",
    parameter: "referralSource",
    currentValue: 20,
    proposedValue: 25,
    rationale: `Referral leads closed at ${Math.round(referralRate * 100)}% vs overall ${Math.round(
      baselineWinRate * 100
    )}% (${referralRows.length} samples).`,
    evidence: {
      sampleSize: referralRows.length,
      winRate: Math.round(referralRate * 1000) / 10,
      baselineWinRate: Math.round(baselineWinRate * 1000) / 10,
    },
    status: "pending",
  });

  return proposals;
}

async function runIntelligenceBatch(options = {}) {
  const since = options.since || windowStart();
  const outcomes = await OutcomeTracking.find({ closedAt: { $gte: since } }).lean();

  if (outcomes.length < MIN_SAMPLE_SIZE) {
    return {
      skipped: true,
      reason: "insufficient_outcomes",
      sampleSize: outcomes.length,
      minRequired: MIN_SAMPLE_SIZE,
    };
  }

  const batchId = options.batchId || `batch-${randomUUID()}`;
  const baselineWinRate = computeWinRate(outcomes);
  const activeConfig = await getActiveConfig();

  const proposalDocs = [
    ...buildMatchingProposals(batchId, outcomes, baselineWinRate, activeConfig.matchingWeights),
    ...buildTemplateProposals(batchId, outcomes, baselineWinRate, activeConfig.followUpTemplates),
    ...buildLeadScoringProposals(batchId, outcomes, baselineWinRate),
  ];

  if (!proposalDocs.length) {
    return {
      batchId,
      sampleSize: outcomes.length,
      baselineWinRate: Math.round(baselineWinRate * 1000) / 10,
      proposalsCreated: 0,
      message: "No statistically meaningful adjustments proposed",
    };
  }

  const created = await RuleChangeProposal.insertMany(proposalDocs);

  return {
    batchId,
    sampleSize: outcomes.length,
    baselineWinRate: Math.round(baselineWinRate * 1000) / 10,
    proposalsCreated: created.length,
    proposalIds: created.map((p) => p._id),
  };
}

async function getIntelligenceMetrics(days = ANALYSIS_WINDOW_DAYS) {
  const since = windowStart(days);
  const outcomes = await OutcomeTracking.find({ closedAt: { $gte: since } }).lean();
  const wins = outcomes.filter((o) => o.outcome === "won").length;
  const losses = outcomes.filter((o) => o.outcome === "lost").length;

  const daysToClose = outcomes
    .map((o) => o.daysToClose)
    .filter((d) => typeof d === "number");
  const avgDaysToClose = daysToClose.length
    ? Math.round((daysToClose.reduce((a, b) => a + b, 0) / daysToClose.length) * 10) / 10
    : null;

  const approvalRates = outcomes
    .map((o) => o.aiApprovalRate)
    .filter((r) => typeof r === "number");
  const avgAiApprovalRate = approvalRates.length
    ? Math.round((approvalRates.reduce((a, b) => a + b, 0) / approvalRates.length) * 10) / 10
    : null;

  const templateGroups = groupByTemplate(outcomes);
  const templateConversionRates = [...templateGroups.entries()]
    .map(([templateId, rows]) => ({
      templateId,
      uses: rows.length,
      wins: rows.filter((r) => r.outcome === "won").length,
      winRate: Math.round(computeWinRate(rows) * 1000) / 10,
    }))
    .sort((a, b) => b.uses - a.uses);

  const pendingProposals = await RuleChangeProposal.countDocuments({ status: "pending" });

  return {
    windowDays: days,
    totalOutcomes: outcomes.length,
    wins,
    losses,
    winRate: outcomes.length ? Math.round((wins / outcomes.length) * 1000) / 10 : 0,
    avgDaysToClose,
    avgAiApprovalRate,
    totalHumanOverrides: outcomes.reduce((sum, o) => sum + (o.humanOverrides || 0), 0),
    templateConversionRates,
    pendingProposals,
  };
}

module.exports = {
  ANALYSIS_WINDOW_DAYS,
  runIntelligenceBatch,
  getIntelligenceMetrics,
  CONFIG_KEYS,
};
