const { randomUUID } = require("crypto");
const OutboxEvent = require("../models/OutboxEvent");
const { validateEventPayload } = require("../schemas/eventSchemaValidator");
const { isOrchestrationEnabled } = require("../config/orchestration");

/**
 * Queue an domain event via the transactional outbox.
 * Caller performs the entity write; this records the outbox row atomically when possible.
 */
async function enqueueOutboxEvent(
  {
    eventType,
    aggregateType,
    aggregateId,
    correlationId,
    payload,
    schemaVersion = 1,
    causationId = null,
    metadata = {},
  },
  session = null
) {
  if (!isOrchestrationEnabled()) {
    return null;
  }

  const validation = validateEventPayload(eventType, schemaVersion, payload);
  if (!validation.valid) {
    throw new Error(
      `Invalid event payload for ${eventType} v${schemaVersion}: ${JSON.stringify(validation.errors)}`
    );
  }

  const outboxId = randomUUID();
  const doc = {
    outboxId,
    eventType,
    aggregateType,
    aggregateId,
    correlationId,
    causationId,
    payload,
    schemaVersion,
    metadata: {
      actor: metadata.actor || "system",
      actorId: metadata.actorId || null,
      ipAddress: metadata.ipAddress || null,
    },
    status: "pending",
  };

  if (session) {
    const [record] = await OutboxEvent.create([doc], { session });
    return record;
  }

  return OutboxEvent.create(doc);
}

/**
 * Write entity + outbox in one MongoDB transaction when supported; sequential fallback otherwise.
 */
async function writeWithOutboxEvent(writeFn, eventMeta) {
  if (!isOrchestrationEnabled()) {
    const entity = await writeFn(null);
    return { entity, outbox: null, correlationId: eventMeta.correlationId };
  }

  const mongoose = require("mongoose");
  const session = await mongoose.startSession();

  try {
    session.startTransaction();
    const entity = await writeFn(session);
    const aggregateId = eventMeta.aggregateId || entity._id;
    const correlationId =
      eventMeta.correlationId ||
      entity.correlationId ||
      randomUUID();

    const payload =
      typeof eventMeta.buildPayload === "function"
        ? eventMeta.buildPayload(entity)
        : eventMeta.payload;

    const outbox = await enqueueOutboxEvent(
      {
        eventType: eventMeta.eventType,
        aggregateType: eventMeta.aggregateType,
        aggregateId,
        correlationId,
        payload,
        schemaVersion: eventMeta.schemaVersion || 1,
        causationId: eventMeta.causationId || null,
        metadata: eventMeta.metadata || {},
      },
      session
    );

    await session.commitTransaction();
    return { entity, outbox, correlationId };
  } catch (err) {
    await session.abortTransaction().catch(() => {});

    if (
      err.message &&
      (err.message.includes("Transaction numbers are only allowed") ||
        err.message.includes("replica set") ||
        err.code === 20)
    ) {
      return writeWithOutboxEventSequential(writeFn, eventMeta);
    }
    throw err;
  } finally {
    session.endSession();
  }
}

async function writeWithOutboxEventSequential(writeFn, eventMeta) {
  const entity = await writeFn(null);
  const aggregateId = eventMeta.aggregateId || entity._id;
  const correlationId =
    eventMeta.correlationId || entity.correlationId || randomUUID();

  const payload =
    typeof eventMeta.buildPayload === "function"
      ? eventMeta.buildPayload(entity)
      : eventMeta.payload;

  const outbox = await enqueueOutboxEvent({
    eventType: eventMeta.eventType,
    aggregateType: eventMeta.aggregateType,
    aggregateId,
    correlationId,
    payload,
    schemaVersion: eventMeta.schemaVersion || 1,
    causationId: eventMeta.causationId || null,
    metadata: eventMeta.metadata || {},
  });

  return { entity, outbox, correlationId };
}

async function replayFailedOutbox(outboxId) {
  const record = await OutboxEvent.findOne({ outboxId, status: "failed" });
  if (!record) {
    throw new Error("Outbox record not found or not in failed state");
  }
  record.status = "pending";
  record.attempts = 0;
  record.lastError = null;
  await record.save();
  return record;
}

module.exports = {
  enqueueOutboxEvent,
  writeWithOutboxEvent,
  replayFailedOutbox,
};
