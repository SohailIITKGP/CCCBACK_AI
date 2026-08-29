const RuleChangeProposal = require("../models/RuleChangeProposal");
const {
  CONFIG_KEYS,
  applyConfigUpdate,
  getActiveConfig,
} = require("./ruleConfigService");

function resolveConfigKey(proposal) {
  if (proposal.ruleSet === "matching") return CONFIG_KEYS.MATCHING_WEIGHTS;
  if (proposal.ruleSet === "follow_up") return CONFIG_KEYS.FOLLOW_UP_TEMPLATES;
  if (proposal.ruleSet === "lead_scoring") return CONFIG_KEYS.LEAD_SCORING;
  return null;
}

function buildNextValue(proposal, currentConfig) {
  const { ruleSet, parameter, proposedValue } = proposal;

  if (ruleSet === "matching") {
    return {
      ...currentConfig.matchingWeights,
      [parameter]: proposedValue,
    };
  }

  if (ruleSet === "follow_up") {
    return {
      ...currentConfig.followUpTemplates,
      [parameter]: proposedValue,
    };
  }

  if (ruleSet === "lead_scoring") {
    return {
      ...currentConfig.leadScoring,
      [parameter]: proposedValue,
    };
  }

  return null;
}

async function listProposals({ status = "pending", limit = 50 } = {}) {
  const query = status === "all" ? {} : { status };
  return RuleChangeProposal.find(query).sort({ createdAt: -1 }).limit(limit).lean();
}

async function approveProposal(proposalId, userId) {
  const proposal = await RuleChangeProposal.findById(proposalId);
  if (!proposal) return { error: "not_found" };
  if (proposal.status !== "pending") {
    return { error: "not_pending", status: proposal.status };
  }

  const configKey = resolveConfigKey(proposal);
  if (!configKey) return { error: "invalid_rule_set" };

  const currentConfig = await getActiveConfig();
  const nextValue = buildNextValue(proposal, currentConfig);
  if (!nextValue) return { error: "invalid_proposal" };

  await applyConfigUpdate({
    configKey,
    value: nextValue,
    userId,
    proposalId: proposal._id,
  });

  proposal.status = "approved";
  proposal.reviewedBy = userId;
  proposal.reviewedAt = new Date();
  proposal.appliedAt = new Date();
  await proposal.save();

  return { approved: true, proposal };
}

async function rejectProposal(proposalId, userId, reason = "") {
  const proposal = await RuleChangeProposal.findById(proposalId);
  if (!proposal) return { error: "not_found" };
  if (proposal.status !== "pending") {
    return { error: "not_pending", status: proposal.status };
  }

  proposal.status = "rejected";
  proposal.reviewedBy = userId;
  proposal.reviewedAt = new Date();
  if (reason) {
    proposal.rationale = `${proposal.rationale}\n[Rejected] ${reason}`.slice(0, 4000);
  }
  await proposal.save();

  return { rejected: true, proposal };
}

module.exports = {
  listProposals,
  approveProposal,
  rejectProposal,
};
