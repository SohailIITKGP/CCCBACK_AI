const Client = require("../../models/Client");
const Property = require("../../models/propertyModel");
const AgentLog = require("../../models/AgentLog");
const {
  notifyManagersOfOverride,
  logPropertyOverrideAudit,
} = require("../../services/propertyOverrideService");
const { isAiPaused } = require("../../services/aiPauseService");

const AGENT_NAME = "PropertyChangeAgent";
const AGENT_VERSION = "1.0.0";

async function handlePropertyOverrideLinked(event) {
  const correlationId = event.correlationId || event.payload?.correlationId;
  if (!correlationId) return { skipped: true, reason: "no_correlation_id" };

  const {
    clientId,
    previousPropertyId,
    newPropertyId,
    newOpportunityId,
    overrideReason,
    aiPropertyId,
    aiScore,
    newPropertyScore,
    supersededOpportunityIds = [],
    actorId,
  } = event.payload || {};

  const [client, previousProperty, newProperty] = await Promise.all([
    Client.findById(clientId).select("name correlationId").lean(),
    previousPropertyId ? Property.findById(previousPropertyId).select("name").lean() : null,
    Property.findById(newPropertyId).select("name").lean(),
  ]);

  await logPropertyOverrideAudit({
    clientId,
    clientName: client?.name,
    previousPropertyId,
    newPropertyId,
    overrideReason,
    aiSuggestion: aiPropertyId ? { propertyId: aiPropertyId, score: aiScore } : null,
    newPropertyScore,
    supersededCount: supersededOpportunityIds.length,
  });

  const { recordFromPropertyOverride } = require("../../services/clientPreferenceMemoryService");
  await recordFromPropertyOverride({
    clientId,
    correlationId,
    overrideReason,
    aiPropertyId: aiPropertyId || previousPropertyId,
    newPropertyId,
    aiScore,
    newPropertyScore,
    userId: actorId,
  }).catch((err) => console.error("[PropertyChangeAgent] preference memory failed:", err.message));

  await notifyManagersOfOverride({
    client,
    previousPropertyName: previousProperty?.name,
    newPropertyName: newProperty?.name,
    overrideReason,
    aiScore,
    newPropertyScore,
    correlationId,
  });

  await AgentLog.create({
    correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
    message: `Property override: ${previousProperty?.name || previousPropertyId || "?"} → ${newProperty?.name || newPropertyId}`,
    result: "success",
    meta: {
      overrideReason,
      aiPropertyId,
      aiScore,
      newPropertyScore,
      supersededOpportunityIds,
      newOpportunityId,
    },
  });

  if (await isAiPaused(correlationId)) {
    return { logged: true, reason: "ai_paused" };
  }

  return { handled: true };
}

async function handlePropertyUnlinked(event) {
  const correlationId = event.correlationId || event.payload?.correlationId;
  const { clientId, propertyId, opportunityId, hadProposalSent } = event.payload || {};

  await AgentLog.create({
    correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    message: `Property unlinked from client (${propertyId})`,
    result: "success",
    meta: { clientId, propertyId, opportunityId, hadProposalSent },
  });

  return { handled: true };
}

async function handleProposalSuperseded(event) {
  const correlationId = event.correlationId || event.payload?.correlationId;

  await AgentLog.create({
    correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    message: `Proposal superseded for opportunity ${event.payload?.opportunityId}`,
    result: "success",
    meta: event.payload,
  });

  return { handled: true };
}

module.exports = {
  AGENT_NAME,
  handlePropertyOverrideLinked,
  handlePropertyUnlinked,
  handleProposalSuperseded,
};
