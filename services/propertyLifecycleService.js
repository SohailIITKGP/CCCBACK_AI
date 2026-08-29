const Opportunity = require("../models/Opportunity");
const Client = require("../models/Client");
const { enqueueOutboxEvent } = require("./outboxService");
const { isOrchestrationEnabled } = require("../config/orchestration");
const { raiseException } = require("./exceptionCenterService");

function normalizeRent(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[,₹]/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

async function emitPropertyLifecycleEvent({
  eventType,
  property,
  previous = {},
  actorUserId = null,
  extraPayload = {},
}) {
  if (!isOrchestrationEnabled() || !property?._id) return null;

  const opportunities = await Opportunity.find({
    property: property._id,
    isVisibility: { $ne: false },
    proposalStatus: { $ne: "superseded" },
  })
    .populate("client", "name correlationId expectedRent")
    .lean();

  const affectedClients = opportunities.map((o) => ({
    clientId: o.client?._id?.toString(),
    clientName: o.client?.name,
    correlationId: o.client?.correlationId,
    opportunityId: o._id.toString(),
    expectedRent: o.client?.expectedRent,
  }));

  return enqueueOutboxEvent({
    eventType,
    aggregateType: "Property",
    aggregateId: property._id,
    correlationId: affectedClients[0]?.correlationId || `property-${property._id}`,
    schemaVersion: 1,
    metadata: { actor: "user", actorId: actorUserId },
    payload: {
      propertyId: property._id.toString(),
      propertyName: property.name,
      city: property.city,
      previousExpectedRent: previous.expectedRent ?? null,
      newExpectedRent: property.expectedRent ?? null,
      propertyStatus: property.propertyStatus,
      isVisibility: property.isVisibility,
      affectedClients,
      affectedCount: affectedClients.length,
      ...extraPayload,
    },
  });
}

async function handlePropertyUpdated(previous, property, actorUserId) {
  const events = [];

  const prevRent = normalizeRent(previous.expectedRent);
  const newRent = normalizeRent(property.expectedRent);
  if (prevRent != null && newRent != null && prevRent !== newRent) {
    events.push(
      await emitPropertyLifecycleEvent({
        eventType: "property.price_changed",
        property,
        previous,
        actorUserId,
        extraPayload: { prevRent, newRent },
      })
    );
  }

  const becameUnavailable =
    (previous.propertyStatus !== "closed" && property.propertyStatus === "closed") ||
    (previous.isVisibility !== false && property.isVisibility === false);

  if (becameUnavailable) {
    events.push(
      await emitPropertyLifecycleEvent({
        eventType: "property.unavailable",
        property,
        previous,
        actorUserId,
        extraPayload: { reason: property.rejectionReason || "status_or_visibility_change" },
      })
    );
  }

  return events.filter(Boolean);
}

async function handlePropertyDeleted(property, actorUserId) {
  const opportunities = await Opportunity.find({ property: property._id })
    .populate("client", "name correlationId")
    .lean();

  for (const opp of opportunities) {
    await raiseException({
      type: "property_deleted",
      correlationId: opp.client?.correlationId,
      entityType: "Opportunity",
      entityId: opp._id,
      title: `Property deleted — ${property.name}`,
      description: `Affected client: ${opp.client?.name || "Unknown"}. Find replacement property.`,
      dedupeKey: `prop_deleted:${property._id}:${opp._id}`,
      payload: {
        propertyId: property._id.toString(),
        propertyName: property.name,
        clientId: opp.client?._id?.toString(),
      },
    });
  }

  if (!isOrchestrationEnabled()) return null;

  return enqueueOutboxEvent({
    eventType: "property.deleted",
    aggregateType: "Property",
    aggregateId: property._id,
    correlationId: `property-${property._id}`,
    schemaVersion: 1,
    metadata: { actor: "user", actorId: actorUserId },
    payload: {
      propertyId: property._id.toString(),
      propertyName: property.name,
      affectedOpportunityIds: opportunities.map((o) => o._id.toString()),
      affectedClientIds: opportunities.map((o) => o.client?._id?.toString()).filter(Boolean),
    },
  });
}

async function sendNoMatchClientEmail(client) {
  if (!client?.email) return { skipped: true, reason: "no_email" };

  const templateService = require("./templateService");
  const { sendMailSafe, getEmailFrom } = require("../utils/smtpTransporter");
  const from = getEmailFrom();
  if (!from) return { skipped: true, reason: "no_smtp" };

  const template = await templateService.getTemplate("client_no_match_v1");
  const rendered = template
    ? templateService.renderTemplate(template, {
        clientName: client.contactPerson || client.name,
        city: client.city || "your preferred city",
      })
    : {
        subject: `Update on your property search — ${client.city || "your area"}`,
        body: `Hi ${client.contactPerson || client.name},\n\nWe are actively sourcing commercial properties matching your requirements in ${client.city || "your preferred area"}. Our team will contact you within 24 hours with options.\n\nRewa Realtors Team`,
      };

  return sendMailSafe({
    from,
    to: client.email,
    subject: rendered.subject,
    text: rendered.body,
  });
}

module.exports = {
  emitPropertyLifecycleEvent,
  handlePropertyUpdated,
  handlePropertyDeleted,
  sendNoMatchClientEmail,
  normalizeRent,
};
