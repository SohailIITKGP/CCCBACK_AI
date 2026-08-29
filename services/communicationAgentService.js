const Lead = require("../models/Lead");
const AgentAction = require("../models/AgentAction");
const AgentLog = require("../models/AgentLog");
const agentActionService = require("./agentActionService");
const processManagerService = require("./processManagerService");
const { enqueueOutboxEvent } = require("./outboxService");
const { sendMailSafe, getEmailFrom } = require("../utils/smtpTransporter");
const { cancelLeadContactSlaCheck } = require("./slaEngineService");
const conversationService = require("./conversationService");
const { logEmailSent } = require("./leadEmailAuditService");

async function executeApprovedAction(action, userId) {
  if (action.status !== "pending_approval") {
    return { error: "invalid_status" };
  }

  if (action.intent !== "send_email") {
    return { error: "unsupported_intent" };
  }

  const { toEmail, subject, body, templateId } = action.payload || {};
  if (!toEmail || !subject || !body) {
    await agentActionService.markFailed(action._id, "Missing email fields");
    return { error: "invalid_payload" };
  }

  const from = getEmailFrom();
  if (!from) {
    await agentActionService.markFailed(action._id, "SMTP not configured");
    return { error: "no_smtp" };
  }

  const sendResult = await sendMailSafe({
    from,
    to: toEmail,
    subject,
    text: body,
  });

  if (!sendResult.sent) {
    await agentActionService.markFailed(action._id, sendResult.reason || "send_failed");
    return { error: "send_failed", reason: sendResult.reason };
  }

  await agentActionService.markExecuted(action._id, {
    messageId: sendResult.messageId,
    toEmail,
    templateId,
    approvedBy: userId?.toString(),
  });

  await AgentAction.findByIdAndUpdate(action._id, { approvedBy: userId });

  if (action.entityType === "Lead") {
    await Lead.findByIdAndUpdate(action.entityId, {
      lifecycleState: "CONTACTED",
    });
    await cancelLeadContactSlaCheck(action.entityId);
  }

  await conversationService.recordOutboundMessage({
    correlationId: action.correlationId,
    entityType: action.entityType,
    entityId: action.entityId,
    channel: "email",
    content: body,
    subject,
    templateId,
    externalMessageId: sendResult.messageId,
    actor: `user:${userId}`,
  });

  if (action.entityType === "Lead") {
    const lead = await Lead.findById(action.entityId).select("name").lean();
    await logEmailSent({
      entityType: "Lead",
      entityId: action.entityId,
      entityName: lead?.name || action.payload?.toEmail,
      toEmail,
      subject,
      templateId,
    });
  }

  await processManagerService.onMessageSent(action.correlationId);

  await enqueueOutboxEvent({
    eventType: "message.sent",
    aggregateType: action.entityType,
    aggregateId: action.entityId,
    correlationId: action.correlationId,
    schemaVersion: 1,
    metadata: { actor: "user", actorId: userId },
    payload: {
      agentActionId: action._id.toString(),
      correlationId: action.correlationId,
      toEmail,
      templateId,
      messageId: sendResult.messageId,
    },
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
      approvedBy: userId?.toString(),
      correlationId: action.correlationId,
    },
  });

  await AgentLog.create({
    correlationId: action.correlationId,
    workerName: "communication",
    agentName: "CommunicationAgent",
    message: `Email sent to ${toEmail}`,
    result: "success",
    meta: { messageId: sendResult.messageId },
  });

  if (action.payload?.proposalLinkIncluded && action.payload?.opportunityId) {
    const { recordProposalDeliveredViaPropertyShare } = require("./opportunityProposalService");
    await recordProposalDeliveredViaPropertyShare({
      opportunityId: action.payload.opportunityId,
      correlationId: action.correlationId,
      actorUserId: userId,
      proposalLink: action.payload.proposalLink,
    });
  }

  return { sent: true, messageId: sendResult.messageId };
}

module.exports = {
  executeApprovedAction,
};
