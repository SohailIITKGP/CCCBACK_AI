const Client = require("../../models/Client");
const DomainEvent = require("../../models/DomainEvent");
const AgentLog = require("../../models/AgentLog");
const agentActionService = require("../../services/agentActionService");
const { tryAutoExecute } = require("../../services/agentAutomationService");
const propertyMatchingService = require("../../services/propertyMatchingService");
const { enqueueOutboxEvent } = require("../../services/outboxService");
const { TOP_SUGGESTION_COUNT } = require("../../config/matchingRules");
const { isAiPaused } = require("../../services/aiPauseService");
const processManagerService = require("../../services/processManagerService");
const { proposePropertyShareEmail } = require("../../services/clientPropertyShareEmailService");
const { raiseException } = require("../../services/exceptionCenterService");
const { sendNoMatchClientEmail } = require("../../services/propertyLifecycleService");

const AGENT_NAME = "PropertyMatchingAgent";
const AGENT_VERSION = "1.0.0";

async function handleClientMatchingEvent(event) {
  const clientId = event.payload?.clientId || event.aggregateId;
  const client = await Client.findById(clientId).lean();
  if (!client) return { skipped: true, reason: "client_not_found" };

  const correlationId = client.correlationId || event.correlationId;
  if (!correlationId) return { skipped: true, reason: "no_correlation_id" };

  if (await isAiPaused(correlationId)) {
    return { skipped: true, reason: "ai_paused" };
  }

  const pending = await agentActionService.hasPendingIntent("Client", client._id, "suggest_properties");
  if (pending) return { skipped: true, reason: "pending_suggestion_exists" };

  const alreadyMatched = await DomainEvent.exists({
    correlationId,
    eventType: "property.matched",
    "payload.clientId": client._id.toString(),
  });
  if (alreadyMatched && event.eventType === "client.created") {
    return { skipped: true, reason: "already_matched" };
  }

  const { matches, candidateCount } = await propertyMatchingService.matchPropertiesForClient(
    client._id,
    { limit: TOP_SUGGESTION_COUNT }
  );

  if (!matches.length) {
    await AgentLog.create({
      correlationId,
      eventId: event.eventId,
      eventType: event.eventType,
      workerName: "orchestrator",
      agentName: AGENT_NAME,
      message: `No property matches (candidates=${candidateCount})`,
      result: "skipped",
    });

    await raiseException({
      type: "no_property_match",
      correlationId,
      entityType: "Client",
      entityId: client._id,
      title: `No property match — ${client.name}`,
      description: `City: ${client.city || "?"}, area: ${client.preferredArea || "?"}, candidates screened: ${candidateCount}`,
      dedupeKey: `no_match:${client._id}`,
      payload: {
        clientId: client._id.toString(),
        candidateCount,
        city: client.city,
        preferredArea: client.preferredArea,
      },
      sourceEventId: event.eventId,
      sourceEventType: event.eventType,
    });

    await sendNoMatchClientEmail(client);

    return { skipped: true, reason: "no_matches", candidateCount };
  }

  const action = await agentActionService.createAction({
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
    intent: "suggest_properties",
    entityType: "Client",
    entityId: client._id,
    correlationId,
    triggerEventId: event.eventId,
    payload: {
      clientId: client._id.toString(),
      clientName: client.name,
      suggestions: matches,
      candidateCount,
    },
    confidence: Math.min(0.95, matches[0].score / 100),
    reasoning: `Top ${matches.length} rule-based matches for ${client.name} (best score ${matches[0].score})`,
    status: "pending_approval",
  });

  await enqueueOutboxEvent({
    eventType: "property.matched",
    aggregateType: "Client",
    aggregateId: client._id,
    correlationId,
    causationId: event.eventId,
    schemaVersion: 1,
    metadata: { actor: `agent:${AGENT_NAME}` },
    payload: {
      clientId: client._id.toString(),
      correlationId,
      agentActionId: action._id.toString(),
      suggestionCount: matches.length,
      topPropertyId: matches[0].propertyId,
      topScore: matches[0].score,
    },
  });

  await enqueueOutboxEvent({
    eventType: "agent.action_proposed",
    aggregateType: "AgentAction",
    aggregateId: action._id,
    correlationId,
    causationId: event.eventId,
    schemaVersion: 1,
    metadata: { actor: `agent:${AGENT_NAME}` },
    payload: {
      agentActionId: action._id.toString(),
      agentName: AGENT_NAME,
      intent: "suggest_properties",
      correlationId,
    },
  });

  await AgentLog.create({
    correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
    message: `Proposed ${matches.length} properties for approval`,
    result: "success",
    meta: { agentActionId: action._id.toString(), topScore: matches[0].score },
  });

  const auto = await tryAutoExecute(action);

  const shareResult = await proposePropertyShareEmail({
    client,
    matches,
    correlationId,
    triggerEventId: event.eventId,
    triggerEventType: event.eventType,
  });

  if (auto.executed) {
    return {
      suggested: true,
      autoLinked: true,
      agentActionId: action._id.toString(),
      count: matches.length,
      propertyShare: shareResult,
    };
  }

  return {
    suggested: true,
    agentActionId: action._id.toString(),
    count: matches.length,
    propertyShare: shareResult,
  };
}

module.exports = {
  AGENT_NAME,
  handleClientMatchingEvent,
};
