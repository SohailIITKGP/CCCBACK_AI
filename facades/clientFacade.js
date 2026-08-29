const Client = require("../models/Client");
const { enqueueOutboxEvent } = require("../services/outboxService");
const { isOrchestrationEnabled } = require("../config/orchestration");

const REQUIREMENT_FIELDS = new Set([
  "city",
  "preferredArea",
  "otherPreferredAreas",
  "expectedRent",
  "minimumArea",
  "requirement",
  "specificRequirements",
  "kindOfBusiness",
  "format",
  "clusters",
]);

function buildActorMeta(actor, ipAddress) {
  return {
    actor: actor?.type === "user" ? "user" : "system",
    actorId: actor?.userId || null,
    ipAddress: ipAddress || null,
  };
}

function requirementFieldsChanged(existing, updates) {
  return Object.keys(updates).some((key) => {
    if (!REQUIREMENT_FIELDS.has(key)) return false;
    return String(existing[key] ?? "") !== String(updates[key] ?? "");
  });
}

async function emitRequirementsUpdated(client, actor = {}, options = {}) {
  if (!isOrchestrationEnabled() || !client.correlationId) return;

  await enqueueOutboxEvent({
    eventType: "client.requirements_updated",
    aggregateType: "Client",
    aggregateId: client._id,
    correlationId: client.correlationId,
    schemaVersion: 1,
    metadata: buildActorMeta(actor, options.ipAddress),
    payload: {
      clientId: client._id.toString(),
      correlationId: client.correlationId,
      city: client.city,
      preferredArea: client.preferredArea,
      expectedRent: client.expectedRent,
      minimumArea: client.minimumArea,
    },
  });
}

module.exports = {
  REQUIREMENT_FIELDS,
  requirementFieldsChanged,
  emitRequirementsUpdated,
};
