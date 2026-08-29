const Lead = require("../models/Lead");
const Client = require("../models/Client");
const AgentAction = require("../models/AgentAction");
const Conversation = require("../models/Conversation");
const OutcomeTracking = require("../models/OutcomeTracking");
const processManagerService = require("./processManagerService");

const TERMINAL_STATUS_MAP = {
  Win: "won",
  Loss: "lost",
  Reject: "lost",
};

function mapStatusToOutcome(status) {
  return TERMINAL_STATUS_MAP[status] || null;
}

function isTerminalOpportunityStatus(status) {
  return Boolean(mapStatusToOutcome(status));
}

async function collectJourneyMetrics(correlationId) {
  const actions = await AgentAction.find({ correlationId }).lean();
  const approved = actions.filter((a) => a.status === "approved" || a.status === "executed").length;
  const rejected = actions.filter((a) => a.status === "rejected").length;
  const decided = approved + rejected;
  const aiApprovalRate = decided > 0 ? Math.round((approved / decided) * 1000) / 10 : null;

  const conversation = await Conversation.findOne({ correlationId })
    .select("channels")
    .lean();
  const templates = new Set();
  for (const msg of conversation?.channels || []) {
    if (msg.templateId) templates.add(msg.templateId);
  }
  for (const action of actions) {
    if (action.payload?.templateId) templates.add(action.payload.templateId);
  }

  return {
    humanOverrides: rejected,
    aiApprovalRate,
    followUpTemplatesUsed: [...templates],
  };
}

async function collectPropertiesShown(clientId, winningPropertyId) {
  const actions = await AgentAction.find({
    entityType: "Client",
    entityId: clientId,
    intent: "suggest_properties",
  })
    .sort({ createdAt: 1 })
    .lean();

  const seen = new Map();
  for (const action of actions) {
    const suggestions = action.payload?.suggestions || action.payload?.properties || [];
    suggestions.forEach((item, index) => {
      const propertyId = item.propertyId || item._id || item.id;
      if (!propertyId) return;
      const key = propertyId.toString();
      if (!seen.has(key)) {
        seen.set(key, {
          propertyId,
          rank: item.rank ?? index + 1,
          accepted: winningPropertyId && key === winningPropertyId.toString(),
        });
      }
    });
  }

  if (winningPropertyId && !seen.has(winningPropertyId.toString())) {
    seen.set(winningPropertyId.toString(), {
      propertyId: winningPropertyId,
      rank: 1,
      accepted: true,
    });
  }

  return [...seen.values()];
}

async function computeDaysToClose(client, correlationId) {
  const lead = correlationId
    ? await Lead.findOne({ correlationId }).select("createdAt").lean()
    : null;
  const start = lead?.createdAt || client?.createdAt;
  if (!start) return null;
  return Math.max(0, Math.round((Date.now() - new Date(start).getTime()) / 86_400_000));
}

/**
 * Record outcome when opportunity reaches Win / Loss / Reject.
 * Idempotent per opportunityId.
 */
async function recordOutcomeFromOpportunity(opportunity, status, options = {}) {
  const outcome = mapStatusToOutcome(status);
  if (!outcome || !opportunity?._id) {
    return { skipped: true, reason: "not_terminal_status" };
  }

  const existing = await OutcomeTracking.findOne({ opportunityId: opportunity._id }).lean();
  if (existing) {
    return { skipped: true, reason: "already_recorded", outcomeId: existing._id };
  }

  const client =
    opportunity.client?._id || opportunity.client
      ? opportunity.client
      : await Client.findById(opportunity.client).lean();
  if (!client) return { skipped: true, reason: "client_not_found" };

  const correlationId = client.correlationId;
  const winningPropertyId = opportunity.property?._id || opportunity.property;

  const [metrics, propertiesShown, daysToClose] = await Promise.all([
    correlationId ? collectJourneyMetrics(correlationId) : Promise.resolve({
      humanOverrides: 0,
      aiApprovalRate: null,
      followUpTemplatesUsed: [],
    }),
    collectPropertiesShown(client._id, outcome === "won" ? winningPropertyId : null),
    computeDaysToClose(client, correlationId),
  ]);

  let leadSource = null;
  if (correlationId) {
    const lead = await Lead.findOne({ correlationId }).select("sourceOfConnection").lean();
    leadSource = lead?.sourceOfConnection || null;
  }

  const doc = await OutcomeTracking.create({
    correlationId: correlationId || `opp-${opportunity._id}`,
    clientId: client._id,
    opportunityId: opportunity._id,
    outcome,
    lossReason: options.lossReason || null,
    propertiesShown,
    followUpTemplatesUsed: metrics.followUpTemplatesUsed,
    leadSource,
    daysToClose,
    humanOverrides: metrics.humanOverrides,
    aiApprovalRate: metrics.aiApprovalRate,
    closedAt: new Date(),
  });

  if (correlationId) {
    await processManagerService.onOpportunityClosed(correlationId, outcome);
  }

  return { recorded: true, outcomeId: doc._id, outcome };
}

module.exports = {
  mapStatusToOutcome,
  isTerminalOpportunityStatus,
  recordOutcomeFromOpportunity,
};
