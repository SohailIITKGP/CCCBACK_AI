const agentActionService = require("./agentActionService");
const linkFacade = require("../facades/linkFacade");
const processManagerService = require("./processManagerService");
const { enqueueOutboxEvent } = require("./outboxService");
const AgentLog = require("../models/AgentLog");

/**
 * Approve AI property suggestion — links rank-1 property and creates opportunity.
 */
async function executeApprovedSuggestion(action, userId) {
  if (action.status !== "pending_approval") {
    return { error: "invalid_status" };
  }
  if (action.intent !== "suggest_properties") {
    return { error: "unsupported_intent" };
  }

  const { clientId, suggestions = [] } = action.payload || {};
  const top = suggestions.find((s) => s.rank === 1) || suggestions[0];

  if (!clientId || !top?.propertyId) {
    await agentActionService.markFailed(action._id, "Missing client or property in payload");
    return { error: "invalid_payload" };
  }

  const linkResult = await linkFacade.linkPropertyToClient({
    clientId,
    propertyId: top.propertyId,
    userId,
    actorMeta: {
      actor: "user",
      correlationId: action.correlationId,
    },
  });

  if (linkResult.error) {
    await agentActionService.markFailed(action._id, linkResult.message || linkResult.error);
    return { error: linkResult.error, message: linkResult.message };
  }

  await agentActionService.markExecuted(action._id, {
    linkedPropertyId: top.propertyId,
    opportunityId: linkResult.opportunity?._id?.toString(),
    score: top.score,
    approvedBy: userId?.toString(),
  });

  await require("../models/AgentAction").findByIdAndUpdate(action._id, {
    approvedBy: userId,
  });

  await enqueueOutboxEvent({
    eventType: "agent.action_approved",
    aggregateType: "AgentAction",
    aggregateId: action._id,
    correlationId: action.correlationId,
    schemaVersion: 1,
    metadata: { actor: "user", actorId: userId },
    payload: {
      agentActionId: action._id.toString(),
      intent: "suggest_properties",
      propertyId: top.propertyId,
      opportunityId: linkResult.opportunity?._id?.toString(),
      correlationId: action.correlationId,
    },
  });

  await AgentLog.create({
    correlationId: action.correlationId,
    workerName: "property_matching",
    agentName: "PropertyMatchingAgent",
    message: `Linked property ${top.propertyId} after approval`,
    result: "success",
    meta: { opportunityId: linkResult.opportunity?._id?.toString() },
  });

  return {
    linked: true,
    propertyId: top.propertyId,
    opportunityId: linkResult.opportunity?._id?.toString(),
    opportunity: linkResult.opportunity,
  };
}

module.exports = {
  executeApprovedSuggestion,
};
