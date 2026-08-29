const AgentLog = require("../../models/AgentLog");
const { isAiPaused } = require("../../services/aiPauseService");
const { handleLeadEmailReply } = require("../../services/leadEmailConversionService");
const { handleClientEmailReply } = require("../../services/clientEmailReplyService");
const { cancelSequence } = require("../../services/leadFollowUpSequenceService");
const { getAutomationActorId } = require("../../services/agentAutomationService");

const AGENT_NAME = "ResponseAgent";

/** Inbound reply received — parse email, route lead or client workflows. */
async function handleMessageReplied(event) {
  const correlationId = event.correlationId;
  if (!correlationId) return { skipped: true };

  if (await isAiPaused(correlationId)) {
    await AgentLog.create({
      correlationId,
      eventId: event.eventId,
      eventType: event.eventType,
      workerName: "orchestrator",
      agentName: AGENT_NAME,
      message: "Inbound reply logged; AI paused — no auto follow-up",
      result: "skipped",
    });
    return { skipped: true, reason: "ai_paused" };
  }

  let conversionResult = null;
  let clientReplyResult = null;

  if (event.payload?.entityType === "Lead") {
    const leadId = event.payload?.entityId || event.aggregateId;
    if (leadId) {
      await cancelSequence(leadId, "replied");
    }

    try {
      conversionResult = await handleLeadEmailReply(event);
    } catch (err) {
      await AgentLog.create({
        correlationId,
        eventId: event.eventId,
        eventType: event.eventType,
        workerName: "orchestrator",
        agentName: "LeadConversionAgent",
        message: `Email conversion check failed: ${err.message}`,
        result: "failed",
      });
    }
  }

  if (event.payload?.entityType === "Client") {
    try {
      const actorUserId = await getAutomationActorId();
      clientReplyResult = await handleClientEmailReply({
        clientId: event.payload?.entityId || event.aggregateId,
        correlationId,
        content: event.payload?.preview,
        subject: event.payload?.subject,
        messageId: event.payload?.externalMessageId,
        actorUserId,
        eventId: event.eventId,
      });
    } catch (err) {
      await AgentLog.create({
        correlationId,
        eventId: event.eventId,
        eventType: event.eventType,
        workerName: "orchestrator",
        agentName: "ClientReplyAgent",
        message: `Client reply routing failed: ${err.message}`,
        result: "failed",
      });
    }
  }

  const message = conversionResult?.converted
    ? "Inbound email — lead converted to client from requirements"
    : conversionResult?.proposed
      ? "Inbound email — conversion proposed for approval"
      : conversionResult?.autoReply?.sent
        ? "Inbound email — auto-replied asking for requirement details"
        : conversionResult?.reason === "incomplete_requirements"
          ? "Inbound email — incomplete details logged"
          : clientReplyResult?.handled
            ? `Client reply — ${clientReplyResult.intent?.intentId || "processed"}`
            : clientReplyResult?.reviewed
              ? "Client reply — sent to Exception Center for review"
              : `Inbound ${event.payload?.channel || "message"} received`;

  await AgentLog.create({
    correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    message,
    result: "success",
    meta: {
      preview: event.payload?.preview,
      conversion: conversionResult?.reason || conversionResult?.converted || null,
      clientReply: clientReplyResult?.intent?.intentId || null,
    },
  });

  return { logged: true, conversion: conversionResult, clientReply: clientReplyResult };
}

module.exports = {
  AGENT_NAME,
  handleMessageReplied,
};
