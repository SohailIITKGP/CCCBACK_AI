const DomainEvent = require("../models/DomainEvent");
const OutboxEvent = require("../models/OutboxEvent");
const { getEventQueue } = require("../queues/eventQueue");

const BATCH_SIZE = 50;
const MAX_PUBLISH_ATTEMPTS = 5;

async function publishDomainEventFromOutbox(outboxRecord) {
  const timestamp = new Date();
  const eventId = outboxRecord.outboxId;

  let domainEvent;
  try {
    domainEvent = await DomainEvent.create({
      eventId,
      eventType: outboxRecord.eventType,
      aggregateType: outboxRecord.aggregateType,
      aggregateId: outboxRecord.aggregateId,
      correlationId: outboxRecord.correlationId,
      causationId: outboxRecord.causationId,
      payload: outboxRecord.payload,
      schemaVersion: outboxRecord.schemaVersion,
      metadata: {
        actor: outboxRecord.metadata?.actor || "system:outbox_publisher",
        actorId: outboxRecord.metadata?.actorId || null,
        timestamp,
        ipAddress: outboxRecord.metadata?.ipAddress || null,
      },
    });
  } catch (err) {
    if (err.code !== 11000) throw err;
    domainEvent = await DomainEvent.findOne({ eventId });
    if (!domainEvent) throw err;
  }

  const queue = getEventQueue();
  await queue.add(
    outboxRecord.eventType,
    {
      eventId: domainEvent.eventId,
      eventType: domainEvent.eventType,
      aggregateType: domainEvent.aggregateType,
      aggregateId: domainEvent.aggregateId.toString(),
      correlationId: domainEvent.correlationId,
      payload: domainEvent.payload,
      schemaVersion: domainEvent.schemaVersion,
      metadata: domainEvent.metadata,
    },
    { jobId: domainEvent.eventId }
  );

  outboxRecord.status = "published";
  outboxRecord.publishedAt = timestamp;
  outboxRecord.lastError = null;
  await outboxRecord.save();

  return domainEvent;
}

async function publishOutboxBatch() {
  const pending = await OutboxEvent.find({ status: "pending" })
    .sort({ createdAt: 1 })
    .limit(BATCH_SIZE);

  const results = { published: 0, failed: 0 };

  for (const record of pending) {
    try {
      await publishDomainEventFromOutbox(record);
      results.published += 1;
    } catch (err) {
      record.attempts += 1;
      record.lastError = err.message;
      if (record.attempts >= MAX_PUBLISH_ATTEMPTS) {
        record.status = "failed";
        console.error(
          `[outbox] publish failed permanently for ${record.outboxId}:`,
          err.message
        );
      }
      await record.save();
      results.failed += 1;
    }
  }

  return results;
}

async function getJourneyEvents(correlationId) {
  return DomainEvent.find({ correlationId })
    .sort({ "metadata.timestamp": 1 })
    .lean();
}

async function getRecentEvents(limit = 50) {
  return DomainEvent.find({})
    .sort({ "metadata.timestamp": -1 })
    .limit(Math.min(limit, 200))
    .lean();
}

module.exports = {
  publishOutboxBatch,
  publishDomainEventFromOutbox,
  getJourneyEvents,
  getRecentEvents,
};
