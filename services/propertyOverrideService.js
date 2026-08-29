const DomainEvent = require("../models/DomainEvent");
const Opportunity = require("../models/Opportunity");
const Client = require("../models/Client");
const Property = require("../models/propertyModel");
const AgentLog = require("../models/AgentLog");
const User = require("../models/User");
const { enqueueOutboxEvent } = require("./outboxService");
const { cancelProposalFollowUp } = require("./opportunityProposalFollowUpService");
const { cancelAllProposalTimers } = require("./opportunityProposalStaleService");
const { scorePropertyForClient } = require("./propertyMatchingService");
const { isValidOverrideReason, SCORE_DELTA_NOTIFY_THRESHOLD } = require("../config/propertyOverride");
const createNotification = require("../utils/notification");
const { logAutomationEvent } = require("../utils/auditLogger");

async function findAiSuggestedProperty(clientId, correlationId) {
  if (correlationId) {
    const matched = await DomainEvent.findOne({
      correlationId,
      eventType: "property.matched",
      "payload.clientId": clientId.toString(),
    })
      .sort({ createdAt: -1 })
      .lean();

    if (matched?.payload?.topPropertyId) {
      return {
        propertyId: String(matched.payload.topPropertyId),
        score: matched.payload.topScore ?? null,
        source: "property.matched",
      };
    }
  }

  const AgentAction = require("../models/AgentAction");
  const action = await AgentAction.findOne({
    entityType: "Client",
    entityId: clientId,
    intent: "suggest_properties",
    status: { $in: ["executed", "approved"] },
  })
    .sort({ updatedAt: -1 })
    .lean();

  const top = action?.payload?.suggestions?.[0];
  if (top?.propertyId) {
    return {
      propertyId: String(top.propertyId),
      score: top.score ?? null,
      source: "agent_action",
      agentActionId: action._id.toString(),
    };
  }

  return null;
}

async function findActiveOpportunitiesForClient(clientId, excludePropertyId = null) {
  const query = {
    client: clientId,
    isVisibility: { $ne: false },
    proposalStatus: { $ne: "superseded" },
  };

  const rows = await Opportunity.find(query)
    .populate("property", "name city")
    .sort({ updatedAt: -1 })
    .lean();

  return rows.filter((row) => {
    const pid = row.property?._id?.toString() || row.property?.toString();
    if (!pid) return false;
    if (excludePropertyId && pid === String(excludePropertyId)) return false;
    return true;
  });
}

async function scorePropertyForClientId(clientId, propertyId) {
  const client = await Client.findById(clientId).lean();
  const property = await Property.findById(propertyId).lean();
  if (!client || !property) return null;

  const ruleConfigService = require("./ruleConfigService");
  const weights = await ruleConfigService.getMatchingWeights();
  const match = scorePropertyForClient(client, property, weights);
  return match?.score ?? null;
}

async function buildOverridePreview({ clientId, propertyId, correlationId }) {
  const aiSuggestion = await findAiSuggestedProperty(clientId, correlationId);
  const activeOpportunities = await findActiveOpportunitiesForClient(clientId, propertyId);
  const newPropertyScore = await scorePropertyForClientId(clientId, propertyId);

  const aiDiffers =
    aiSuggestion && String(aiSuggestion.propertyId) !== String(propertyId);
  const hasOtherActive = activeOpportunities.length > 0;
  const requiresOverrideReason = Boolean(aiDiffers || hasOtherActive);

  return {
    requiresOverrideReason,
    aiSuggestion: aiSuggestion
      ? {
          ...aiSuggestion,
          propertyName: (
            await Property.findById(aiSuggestion.propertyId).select("name").lean()
          )?.name,
        }
      : null,
    activeOpportunities: activeOpportunities.map((o) => ({
      opportunityId: o._id.toString(),
      propertyId: o.property?._id?.toString(),
      propertyName: o.property?.name,
      proposalEmailSentAt: o.proposalEmailSentAt || null,
      status: o.status,
    })),
    newPropertyScore,
  };
}

async function supersedeOpportunity({
  opportunity,
  supersededByOpportunityId,
  meta = {},
  actorUserId = null,
  correlationId,
}) {
  if (!opportunity || opportunity.proposalStatus === "superseded") {
    return { skipped: true, reason: "already_superseded" };
  }

  await cancelAllProposalTimers(opportunity._id.toString());

  await Opportunity.findByIdAndUpdate(opportunity._id, {
    proposalStatus: "superseded",
    supersededAt: new Date(),
    supersededByOpportunity: supersededByOpportunityId || null,
    supersedeMeta: {
      overrideReason: meta.overrideReason || null,
      overrideReasonNote: meta.overrideReasonNote || null,
      aiPropertyId: meta.aiPropertyId || null,
      aiScore: meta.aiScore ?? null,
      newPropertyScore: meta.newPropertyScore ?? null,
      newPropertyId: meta.newPropertyId || null,
      supersededByActorId: actorUserId || null,
    },
  });

  if (correlationId) {
    await enqueueOutboxEvent({
      eventType: "proposal.superseded",
      aggregateType: "Opportunity",
      aggregateId: opportunity._id,
      correlationId,
      schemaVersion: 1,
      metadata: { actor: "user", actorId: actorUserId || null },
      payload: {
        opportunityId: opportunity._id.toString(),
        supersededByOpportunityId: supersededByOpportunityId?.toString() || null,
        clientId: opportunity.client?.toString?.() || String(opportunity.client),
        propertyId: opportunity.property?._id?.toString() || String(opportunity.property),
        correlationId,
        overrideReason: meta.overrideReason || null,
        hadProposalSent: Boolean(opportunity.proposalEmailSentAt),
      },
    });
  }

  return { superseded: true, opportunityId: opportunity._id.toString() };
}

async function supersedePriorOpportunities({
  clientId,
  newPropertyId,
  newOpportunityId,
  overrideReason,
  overrideReasonNote,
  actorUserId,
  correlationId,
  aiSuggestion,
  newPropertyScore,
}) {
  const active = await findActiveOpportunitiesForClient(clientId, newPropertyId);
  const results = [];

  for (const opp of active) {
    const result = await supersedeOpportunity({
      opportunity: opp,
      supersededByOpportunityId: newOpportunityId,
      meta: {
        overrideReason,
        overrideReasonNote,
        aiPropertyId: aiSuggestion?.propertyId || null,
        aiScore: aiSuggestion?.score ?? null,
        newPropertyScore,
        newPropertyId: String(newPropertyId),
      },
      actorUserId,
      correlationId,
    });
    results.push(result);
  }

  return results;
}

function validateOverrideReason(required, overrideReason, overrideReasonNote) {
  if (!required) return { valid: true };
  if (!isValidOverrideReason(overrideReason)) {
    return {
      valid: false,
      error: "override_reason_required",
      message: "Override reason is required when switching from the AI-suggested or active property.",
    };
  }
  if (overrideReason === "other" && !String(overrideReasonNote || "").trim()) {
    return {
      valid: false,
      error: "override_note_required",
      message: "Please provide a short note when reason is Other.",
    };
  }
  return { valid: true };
}

async function notifyManagersOfOverride({
  client,
  previousPropertyName,
  newPropertyName,
  overrideReason,
  aiScore,
  newPropertyScore,
  correlationId,
}) {
  const scoreDelta =
    typeof aiScore === "number" && typeof newPropertyScore === "number"
      ? aiScore - newPropertyScore
      : null;

  if (scoreDelta != null && Math.abs(scoreDelta) < SCORE_DELTA_NOTIFY_THRESHOLD) {
    return { notified: 0, skipped: true, reason: "score_delta_below_threshold" };
  }

  const managers = await User.find({
    role: { $in: ["Manager", "Super Admin"] },
    status: "Active",
  }).select("_id");

  const message = [
    `${client?.name || "Client"}: property switched`,
    previousPropertyName ? `from ${previousPropertyName}` : "",
    newPropertyName ? `to ${newPropertyName}` : "",
    overrideReason ? `(reason: ${overrideReason})` : "",
    scoreDelta != null ? `[AI score Δ ${scoreDelta}]` : "",
  ]
    .filter(Boolean)
    .join(" ");

  for (const manager of managers) {
    await createNotification(
      "Client",
      "Property override",
      client._id,
      client?.name || "Client",
      manager._id,
      message
    );
  }

  if (correlationId) {
    await AgentLog.create({
      correlationId,
      eventType: "property.override_linked",
      workerName: "property_override",
      agentName: "PropertyOverrideService",
      message: `Managers notified of property override (${managers.length})`,
      result: "success",
      meta: { overrideReason, aiScore, newPropertyScore, scoreDelta },
    });
  }

  return { notified: managers.length };
}

async function logPropertyOverrideAudit({
  clientId,
  clientName,
  previousPropertyId,
  newPropertyId,
  overrideReason,
  aiSuggestion,
  newPropertyScore,
  supersededCount,
}) {
  await logAutomationEvent({
    action: "property_override_linked",
    resource: "Client",
    resourceId: clientId,
    entityName: clientName,
    details: {
      previousPropertyId,
      newPropertyId,
      overrideReason,
      aiPropertyId: aiSuggestion?.propertyId || null,
      aiScore: aiSuggestion?.score ?? null,
      newPropertyScore,
      supersededOpportunityCount: supersededCount,
    },
  });
}

module.exports = {
  findAiSuggestedProperty,
  findActiveOpportunitiesForClient,
  buildOverridePreview,
  supersedeOpportunity,
  supersedePriorOpportunities,
  validateOverrideReason,
  scorePropertyForClientId,
  notifyManagersOfOverride,
  logPropertyOverrideAudit,
};
