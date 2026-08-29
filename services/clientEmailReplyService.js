const Client = require("../models/Client");
const Opportunity = require("../models/Opportunity");
const DomainEvent = require("../models/DomainEvent");
const AgentLog = require("../models/AgentLog");
const AgentAction = require("../models/AgentAction");
const FollowUpTask = require("../models/FollowUpTask");
const { detectClientIntent } = require("./clientReplyIntentService");
const { raiseException } = require("./exceptionCenterService");
const { isAiPaused } = require("./aiPauseService");
const linkFacade = require("../facades/linkFacade");
const { proposeSiteVisitFromEvent } = require("../agents/handlers/dealOrchestratorHandler");
const createNotification = require("../utils/notification");
const conversationService = require("./conversationService");
const { sendMailSafe, getEmailFrom } = require("../utils/smtpTransporter");
const templateService = require("./templateService");

const AGENT_NAME = "ClientReplyAgent";

async function wasClientReplyAlreadyProcessed(messageId) {
  if (!messageId) return false;
  return Boolean(
    await AgentLog.exists({
      agentName: AGENT_NAME,
      "meta.inboundMessageId": messageId,
    })
  );
}

async function getLatestInboundBody(correlationId, preview = "") {
  if (preview) return preview;
  const conv = await conversationService.getConversation(correlationId);
  const channels = conv?.channels || [];
  const lastInbound = [...channels].reverse().find((c) => c.direction === "inbound");
  return lastInbound?.content || "";
}

async function findActiveOpportunity(clientId) {
  return Opportunity.findOne({
    client: clientId,
    isVisibility: { $ne: false },
    proposalStatus: { $ne: "superseded" },
    proposalEmailSentAt: { $exists: true, $ne: null },
  })
    .sort({ proposalEmailSentAt: -1 })
    .populate("property", "name")
    .lean();
}

async function getLastSharedPropertyIds(clientId, correlationId) {
  const shared = await DomainEvent.findOne({
    correlationId,
    eventType: "properties.shared",
    "payload.clientId": clientId.toString(),
  })
    .sort({ createdAt: -1 })
    .lean();

  if (shared?.payload?.propertyIds?.length) {
    return shared.payload.propertyIds.map(String);
  }

  const action = await AgentAction.findOne({
    entityType: "Client",
    entityId: clientId,
    intent: "send_email",
    status: { $in: ["executed", "approved", "pending_approval"] },
    "payload.templateId": "client_properties_share_v1",
  })
    .sort({ createdAt: -1 })
    .lean();

  return (action?.payload?.propertyIds || []).map(String);
}

async function createCallTask({ client, correlationId, subject, bodyPreview }) {
  const assigneeId = client.assignedTo || client.whoConverted;
  if (!assigneeId) {
    return { skipped: true, reason: "no_assignee" };
  }

  const sourceKey = `client-call:${client._id}:${Date.now()}`;
  const dueDate = new Date();
  dueDate.setHours(dueDate.getHours() + 4);

  await FollowUpTask.create({
    title: `Call client — ${client.name}`,
    description: `Client requested a call via email.${subject ? ` Subject: ${subject}` : ""}${bodyPreview ? `\n\n"${bodyPreview.slice(0, 200)}"` : ""}`,
    assignedTo: assigneeId,
    entityType: "opportunity",
    clientName: client.name,
    taskType: "follow_up",
    dueDate,
    sourceKey,
    meta: { correlationId, source: "client_email_reply" },
  });

  await createNotification(
    "Client",
    "Call requested",
    client._id,
    client.name,
    assigneeId,
    `Client ${client.name} requested a call via email`
  );

  return { created: true, assigneeId: assigneeId.toString() };
}

async function sendClientAckEmail(client, templateId, variables) {
  if (!client?.email) return { skipped: true, reason: "no_email" };
  const from = getEmailFrom();
  if (!from) return { skipped: true, reason: "no_smtp" };

  const template = await templateService.getTemplate(templateId);
  const rendered = template
    ? templateService.renderTemplate(template, variables)
    : {
        subject: "We received your message",
        body: `Hi ${variables.clientName},\n\nThank you for your reply. Our team will contact you shortly.\n\nRewa Realtors Team`,
      };

  const result = await sendMailSafe({
    from,
    to: client.email,
    subject: rendered.subject,
    text: rendered.body,
  });

  return result;
}

async function workflowProposeSiteVisit(client, correlationId, eventMeta = {}) {
  const opportunity = await findActiveOpportunity(client._id);
  if (!opportunity) {
    await raiseException({
      type: "client_intent_review",
      correlationId,
      entityType: "Client",
      entityId: client._id,
      title: `Site visit requested — no active proposal for ${client.name}`,
      description: "Client asked for site visit but no proposal-on-record opportunity found.",
      dedupeKey: `site_visit_no_opp:${client._id}`,
      payload: { intent: "book_site_visit" },
    });
    return { exception: true };
  }

  const fakeEvent = {
    eventId: eventMeta.eventId || `client-reply-${Date.now()}`,
    eventType: "proposal.replied",
    correlationId,
    payload: {
      opportunityId: opportunity._id.toString(),
      correlationId,
      source: "client_email_intent",
    },
  };

  const result = await proposeSiteVisitFromEvent(fakeEvent);
  return { siteVisit: result, opportunityId: opportunity._id.toString() };
}

async function workflowLinkAlternateProperty(client, optionNumber, actorUserId, correlationId) {
  const propertyIds = await getLastSharedPropertyIds(client._id, correlationId);
  if (!propertyIds.length) {
    await raiseException({
      type: "client_intent_review",
      correlationId,
      entityType: "Client",
      entityId: client._id,
      title: `Client wants option ${optionNumber || "?"} — no prior property list`,
      description: "Could not find shared property list for this client.",
      payload: { intent: "want_another_option", optionNumber },
    });
    return { exception: true };
  }

  const index = Math.max(0, (optionNumber || 2) - 1);
  const propertyId = propertyIds[index] || propertyIds[propertyIds.length - 1];

  const linkResult = await linkFacade.linkPropertyToClient({
    clientId: client._id,
    propertyId,
    userId: actorUserId,
    actorMeta: { actor: "agent:ClientReplyAgent", correlationId },
    skipNotifications: false,
    overrideReason: "client_preference",
  });

  return linkResult;
}

async function workflowRematchCheaper(client, correlationId) {
  await raiseException({
    type: "client_intent_review",
    correlationId,
    entityType: "Client",
    entityId: client._id,
    title: `Client wants cheaper options — ${client.name}`,
    description: `Current budget: ${client.expectedRent || "not set"}. Re-run matching with lower rent filter.`,
    dedupeKey: `cheaper:${client._id}:${new Date().toISOString().slice(0, 10)}`,
    payload: { intent: "want_cheaper", expectedRent: client.expectedRent },
  });

  const { enqueueOutboxEvent } = require("./outboxService");
  const { isOrchestrationEnabled } = require("../config/orchestration");
  if (isOrchestrationEnabled() && correlationId) {
    await enqueueOutboxEvent({
      eventType: "client.requirements_updated",
      aggregateType: "Client",
      aggregateId: client._id,
      correlationId,
      schemaVersion: 1,
      metadata: { actor: "agent:ClientReplyAgent" },
      payload: {
        clientId: client._id.toString(),
        correlationId,
        trigger: "want_cheaper_reply",
      },
    });
  }

  return { rematchTriggered: true };
}

async function handleClientEmailReply({
  clientId,
  correlationId,
  content,
  subject,
  messageId,
  actorUserId = null,
  eventId = null,
}) {
  if (messageId && (await wasClientReplyAlreadyProcessed(messageId))) {
    return { skipped: true, reason: "already_processed" };
  }

  if (await isAiPaused(correlationId)) {
    return { skipped: true, reason: "ai_paused" };
  }

  const client = await Client.findById(clientId);
  if (!client) return { skipped: true, reason: "client_not_found" };

  const body = content || (await getLatestInboundBody(correlationId));
  const intent = detectClientIntent(body);

  await AgentLog.create({
    correlationId,
    eventId: messageId || eventId,
    eventType: "client.email_reply",
    workerName: "inbound",
    agentName: AGENT_NAME,
    message: intent.intentId
      ? `Detected intent: ${intent.intentId} (${Math.round(intent.confidence * 100)}%)`
      : "Client reply — no clear intent",
    result: "success",
    meta: { intent, subject, preview: intent.text?.slice(0, 120), inboundMessageId: messageId },
  });

  if (intent.needsReview || !intent.workflow) {
    await raiseException({
      type: "client_intent_review",
      correlationId,
      entityType: "Client",
      entityId: client._id,
      title: `Review client reply — ${client.name}`,
      description: intent.text?.slice(0, 300) || "Unclear client email reply",
      dedupeKey: messageId ? `intent_review:${messageId}` : null,
      payload: { intent, subject, messageId },
    });

    await sendClientAckEmail(client, "client_reply_ack_v1", {
      clientName: client.contactPerson || client.name,
    });

    return { reviewed: true, intent };
  }

  let workflowResult = null;

  switch (intent.workflow) {
    case "propose_site_visit":
      workflowResult = await workflowProposeSiteVisit(client, correlationId, { eventId });
      break;
    case "create_call_task":
      workflowResult = await createCallTask({
        client,
        correlationId,
        subject,
        bodyPreview: intent.text,
      });
      await sendClientAckEmail(client, "client_reply_ack_v1", {
        clientName: client.contactPerson || client.name,
      });
      break;
    case "link_alternate_property":
      workflowResult = await workflowLinkAlternateProperty(
        client,
        intent.optionNumber,
        actorUserId,
        correlationId
      );
      break;
    case "rematch_cheaper":
      workflowResult = await workflowRematchCheaper(client, correlationId);
      break;
    case "propose_close":
      await raiseException({
        type: "client_intent_review",
        correlationId,
        entityType: "Client",
        entityId: client._id,
        title: `Client not interested — ${client.name}`,
        description: intent.text?.slice(0, 300),
        payload: { intent: "not_interested", suggestAction: "close_opportunity" },
        dedupeKey: `not_interested:${client._id}:${new Date().toISOString().slice(0, 10)}`,
      });
      workflowResult = { proposeClose: true };
      break;
    case "create_document_task":
      workflowResult = await createCallTask({
        client,
        correlationId,
        subject,
        bodyPreview: `Documents requested: ${intent.text?.slice(0, 200)}`,
      });
      await raiseException({
        type: "client_intent_review",
        correlationId,
        entityType: "Client",
        entityId: client._id,
        title: `Documents requested — ${client.name}`,
        description: intent.text?.slice(0, 300),
        payload: { intent: "need_documents" },
      });
      break;
    case "ack_only":
      workflowResult = { ackOnly: true };
      break;
    default:
      await raiseException({
        type: "client_intent_review",
        correlationId,
        entityType: "Client",
        entityId: client._id,
        title: `Unhandled intent — ${client.name}`,
        description: intent.text?.slice(0, 300),
        payload: { intent },
      });
  }

  if (intent.intentId && !intent.needsReview) {
    const propertyIds = await getLastSharedPropertyIds(client._id, correlationId);
    const { recordFromClientIntent } = require("./clientPreferenceMemoryService");
    await recordFromClientIntent({
      clientId: client._id,
      correlationId,
      intentId: intent.intentId,
      text: intent.text,
      propertyIds,
    }).catch((err) =>
      console.error("[ClientReplyAgent] preference memory failed:", err.message)
    );
  }

  return { handled: true, intent, workflowResult };
}

module.exports = {
  AGENT_NAME,
  handleClientEmailReply,
  detectClientIntent,
};
