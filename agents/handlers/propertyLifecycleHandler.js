const AgentLog = require("../../models/AgentLog");
const { raiseException } = require("../../services/exceptionCenterService");
const { enqueueOutboxEvent } = require("../../services/outboxService");
const { normalizeRent } = require("../../services/propertyLifecycleService");

const AGENT_NAME = "PropertyLifecycleAgent";

async function handlePropertyUnavailable(event) {
  const { propertyId, propertyName, affectedClients = [], reason } = event.payload || {};

  for (const row of affectedClients) {
    if (!row.correlationId) continue;

    if (row.clientId) {
      const { addPreferenceEntry } = require("../../services/clientPreferenceMemoryService");
      await addPreferenceEntry({
        clientId: row.clientId,
        correlationId: row.correlationId,
        type: "property_rejected",
        propertyId,
        value: "property_unavailable",
        source: "system",
        evidence: `Property ${propertyName || propertyId} became unavailable (${reason || "unknown"})`,
        confidence: 0.95,
      }).catch(() => {});
    }

    await raiseException({
      type: "property_unavailable",
      correlationId: row.correlationId,
      entityType: "Opportunity",
      entityId: row.opportunityId,
      title: `Property unavailable — ${propertyName || propertyId}`,
      description: `Client ${row.clientName} was linked to property that is no longer available. Reason: ${reason || "unknown"}`,
      dedupeKey: `unavail:${propertyId}:${row.opportunityId}`,
      payload: { propertyId, clientId: row.clientId, reason },
    });

    if (row.clientId) {
      await enqueueOutboxEvent({
        eventType: "client.requirements_updated",
        aggregateType: "Client",
        aggregateId: row.clientId,
        correlationId: row.correlationId,
        schemaVersion: 1,
        metadata: { actor: `agent:${AGENT_NAME}` },
        payload: {
          clientId: row.clientId,
          correlationId: row.correlationId,
          trigger: "property_unavailable",
          propertyId,
        },
      });
    }
  }

  await AgentLog.create({
    correlationId: event.correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    message: `Property unavailable — ${affectedClients.length} affected client(s)`,
    result: "success",
    meta: { propertyId, affectedCount: affectedClients.length },
  });

  return { handled: true, affected: affectedClients.length };
}

async function handlePropertyPriceChanged(event) {
  const { propertyId, propertyName, affectedClients = [], prevRent, newRent } = event.payload || {};

  for (const row of affectedClients) {
    const clientBudget = normalizeRent(row.expectedRent);
    if (clientBudget == null || newRent == null) continue;
    if (newRent <= clientBudget) continue;

    await raiseException({
      type: "property_price_changed",
      correlationId: row.correlationId,
      entityType: "Opportunity",
      entityId: row.opportunityId,
      title: `Rent increased above client budget — ${propertyName}`,
      description: `Client ${row.clientName} budget ~₹${clientBudget}; new rent ~₹${newRent}. Suggest alternatives.`,
      dedupeKey: `price:${propertyId}:${row.clientId}:${newRent}`,
      payload: { propertyId, clientId: row.clientId, prevRent, newRent, clientBudget },
    });
  }

  await AgentLog.create({
    correlationId: event.correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    message: `Property price changed ₹${prevRent} → ₹${newRent}`,
    result: "success",
    meta: { propertyId, affectedClients: affectedClients.length },
  });

  return { handled: true };
}

async function handlePropertyDeleted(event) {
  await AgentLog.create({
    correlationId: event.correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    message: `Property deleted — ${event.payload?.affectedOpportunityIds?.length || 0} opportunities affected`,
    result: "success",
    meta: event.payload,
  });

  return { handled: true };
}

module.exports = {
  AGENT_NAME,
  handlePropertyUnavailable,
  handlePropertyPriceChanged,
  handlePropertyDeleted,
};
