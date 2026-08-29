const RuleConfig = require("../models/RuleConfig");
const { WEIGHTS: DEFAULT_MATCHING_WEIGHTS } = require("../config/matchingRules");
const { TEMPLATE_BY_PRIORITY: DEFAULT_TEMPLATES } = require("../config/followUpRules");

const CONFIG_KEYS = {
  MATCHING_WEIGHTS: "matching.weights",
  FOLLOW_UP_TEMPLATES: "follow_up.templates",
  LEAD_SCORING: "lead_scoring.bonuses",
};

const DEFAULT_LEAD_SCORING = {
  urgencyKeyword: 30,
  warehouseKeyword: 15,
  referralSource: 20,
  linkedinSource: 10,
  hasEmail: 5,
  hasPhone: 5,
  hotPriority: 25,
  highPriority: 15,
  freshLead: 10,
};

let cache = {
  matchingWeights: null,
  followUpTemplates: null,
  leadScoring: null,
  loadedAt: 0,
};

const CACHE_TTL_MS = 60_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadCache(force = false) {
  if (!force && cache.loadedAt && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache;
  }

  const configs = await RuleConfig.find({
    configKey: { $in: Object.values(CONFIG_KEYS) },
  }).lean();

  const byKey = Object.fromEntries(configs.map((c) => [c.configKey, c.value]));

  cache = {
    matchingWeights: { ...DEFAULT_MATCHING_WEIGHTS, ...(byKey[CONFIG_KEYS.MATCHING_WEIGHTS] || {}) },
    followUpTemplates: { ...DEFAULT_TEMPLATES, ...(byKey[CONFIG_KEYS.FOLLOW_UP_TEMPLATES] || {}) },
    leadScoring: { ...DEFAULT_LEAD_SCORING, ...(byKey[CONFIG_KEYS.LEAD_SCORING] || {}) },
    loadedAt: Date.now(),
  };

  return cache;
}

async function getMatchingWeights() {
  const data = await loadCache();
  return clone(data.matchingWeights);
}

async function getFollowUpTemplates() {
  const data = await loadCache();
  return clone(data.followUpTemplates);
}

async function getLeadScoringBonuses() {
  const data = await loadCache();
  return clone(data.leadScoring);
}

async function getActiveConfig() {
  const data = await loadCache(true);
  return {
    matchingWeights: clone(data.matchingWeights),
    followUpTemplates: clone(data.followUpTemplates),
    leadScoring: clone(data.leadScoring),
  };
}

async function applyConfigUpdate({ configKey, value, userId, proposalId }) {
  await RuleConfig.findOneAndUpdate(
    { configKey },
    {
      configKey,
      value,
      updatedBy: userId || null,
      sourceProposalId: proposalId || null,
    },
    { upsert: true, new: true }
  );
  await loadCache(true);
}

function invalidateCache() {
  cache.loadedAt = 0;
}

module.exports = {
  CONFIG_KEYS,
  DEFAULT_MATCHING_WEIGHTS,
  DEFAULT_LEAD_SCORING,
  DEFAULT_TEMPLATES,
  getMatchingWeights,
  getFollowUpTemplates,
  getLeadScoringBonuses,
  getActiveConfig,
  applyConfigUpdate,
  invalidateCache,
};
