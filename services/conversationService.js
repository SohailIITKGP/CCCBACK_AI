const Conversation = require("../models/Conversation");
const { enqueueOutboxEvent } = require("./outboxService");
const { isOrchestrationEnabled } = require("../config/orchestration");

async function appendMessage({
  correlationId,
  entityType,
  entityId,
  channel,
  direction,
  content,
  subject = "",
  externalMessageId = null,
  templateId = null,
  actor = "system",
  timestamp = new Date(),
}) {
  if (!correlationId || !entityId) {
    return { error: "missing_ids" };
  }

  const entry = {
    channel,
    direction,
    content: String(content || "").slice(0, 10000),
    subject: subject ? String(subject).slice(0, 500) : "",
    externalMessageId,
    templateId,
    timestamp,
    actor,
  };

  const update = {
    $push: { channels: entry },
    $set: { entityType, entityId, correlationId },
  };

  if (direction === "inbound") {
    update.$set.lastInboundAt = timestamp;
    update.$set.awaitingReplyFrom = "internal";
  } else {
    update.$set.lastOutboundAt = timestamp;
    update.$set.awaitingReplyFrom = "client";
  }

  const doc = await Conversation.findOneAndUpdate({ correlationId }, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });

  return { conversation: doc, entry };
}

async function getConversation(correlationId) {
  return Conversation.findOne({ correlationId }).lean();
}

async function recordInboundReply({
  correlationId,
  entityType,
  entityId,
  channel,
  content,
  subject,
  externalMessageId,
  actor = "client",
}) {
  const result = await appendMessage({
    correlationId,
    entityType,
    entityId,
    channel,
    direction: "inbound",
    content,
    subject,
    externalMessageId,
    actor,
  });

  if (result.error || !isOrchestrationEnabled()) {
    return result;
  }

  await enqueueOutboxEvent({
    eventType: "message.replied",
    aggregateType: entityType,
    aggregateId: entityId,
    correlationId,
    schemaVersion: 1,
    metadata: { actor: `channel:${channel}` },
    payload: {
      correlationId,
      entityType,
      entityId: entityId.toString(),
      channel,
      externalMessageId,
      preview: String(content || "").slice(0, 200),
    },
  });

  return result;
}

async function recordOutboundMessage({
  correlationId,
  entityType,
  entityId,
  channel,
  content,
  subject,
  templateId,
  externalMessageId,
  actor = "system",
}) {
  return appendMessage({
    correlationId,
    entityType,
    entityId,
    channel,
    direction: "outbound",
    content,
    subject,
    templateId,
    externalMessageId,
    actor,
  });
}

module.exports = {
  appendMessage,
  getConversation,
  recordInboundReply,
  recordOutboundMessage,
};
