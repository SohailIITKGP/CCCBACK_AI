const Lead = require("../models/Lead");
const User = require("../models/User");
const Conversation = require("../models/Conversation");
const AgentLog = require("../models/AgentLog");
const agentActionService = require("./agentActionService");
const leadFacade = require("../facades/leadFacade");
const {
  parseRequirementsFromEmail,
  isCompleteForConversion,
  cleanText,
} = require("./emailRequirementParserService");
const { isAiPaused } = require("./aiPauseService");
const {
  sendRequestDetailsEmail,
  sendConversionAckEmail,
} = require("./leadEmailResponseService");
const { cancelSequence } = require("./leadFollowUpSequenceService");
const {
  logEmailReplyReceived,
  logRemarksUpdatedFromEmail,
} = require("./leadEmailAuditService");

function automationService() {
  return require("./agentAutomationService");
}

async function getLatestInboundBody(correlationId, preview) {
  const conv = await Conversation.findOne({ correlationId }).select("channels").lean();
  const inbound = [...(conv?.channels || [])]
    .filter((c) => c.direction === "inbound")
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const latest = inbound[0];
  return latest?.content || preview || "";
}

async function resolveAssignee(lead) {
  if (lead.assignedTo) return lead.assignedTo;
  const actorId = await automationService().getAutomationActorId();
  if (actorId) return actorId;
  const fallback = await User.findOne({
    status: "Active",
    role: { $in: ["Super Admin", "Manager", "Employee"] },
  })
    .select("_id")
    .lean();
  return fallback?._id || null;
}

async function wasReplyAlreadyProcessed(messageId) {
  if (!messageId) return false;
  const AgentLog = require("../models/AgentLog");
  return Boolean(
    await AgentLog.exists({
      eventType: { $in: ["lead.email_conversion", "lead.email_reply"] },
      "meta.inboundMessageId": messageId,
    })
  );
}

async function saveParsedRequirementsOnLead(lead, parsed) {
  const parts = [
    parsed.city && `City: ${parsed.city}`,
    parsed.preferredArea && `Area: ${parsed.preferredArea}`,
    parsed.minimumArea && `Size: ${parsed.minimumArea} sqft`,
    parsed.expectedRent && `Budget: ${parsed.expectedRent}`,
    parsed.kindOfBusiness && `Business: ${parsed.kindOfBusiness}`,
  ].filter(Boolean);
  if (!parts.length) return { updated: false };

  const block = `[From email reply]\n${parts.join("\n")}`;
  const existing = String(lead.remarks || "");
  if (existing.includes(block)) return { updated: false, remarks: existing };

  const newRemarks = existing ? `${existing}\n\n${block}` : block;
  await Lead.findByIdAndUpdate(lead._id, { remarks: newRemarks });

  await logRemarksUpdatedFromEmail({
    entityId: lead._id,
    entityName: lead.name,
    previousRemarks: existing,
    newRemarks,
    parsed,
  });

  return { updated: true, remarks: newRemarks };
}

/**
 * Called right after inbound email is saved — sends auto-reply or converts without waiting for worker.
 */
async function processLeadReplyAfterInbound({
  leadId,
  correlationId,
  content,
  subject,
  messageId,
  fromEmail,
}) {
  if (messageId && (await wasReplyAlreadyProcessed(messageId))) {
    return { skipped: true, reason: "already_processed" };
  }

  const lead = await Lead.findById(leadId);
  if (!lead || lead.isConverted || !lead.correlationId) {
    return { skipped: true, reason: "lead_not_eligible" };
  }

  if (await isAiPaused(correlationId)) {
    return { skipped: true, reason: "ai_paused" };
  }

  const parsed = parseRequirementsFromEmail(content);

  await saveParsedRequirementsOnLead(lead, parsed);
  await cancelSequence(lead._id, "replied");

  await logEmailReplyReceived({
    entityType: "Lead",
    entityId: lead._id,
    entityName: lead.name,
    fromEmail,
    subject,
    parsed,
    complete: isCompleteForConversion(parsed),
  });

  if (!isCompleteForConversion(parsed)) {
    const autoReply = await sendRequestDetailsEmail(lead, parsed);
    await AgentLog.create({
      correlationId,
      eventType: "lead.email_reply",
      workerName: "inbound",
      agentName: "LeadConversionAgent",
      message: autoReply.sent
        ? "Auto-replied asking for requirement details"
        : `Reply received — auto-reply skipped (${autoReply.reason || autoReply.error || "unknown"})`,
      result: autoReply.sent ? "success" : "skipped",
      meta: { inboundMessageId: messageId, fromEmail, subject, autoReply },
    });
    return { incomplete: true, autoReply };
  }

  const settings = await automationService().getAutomationSettings();
  const actorId = await automationService().getAutomationActorId();

  if (settings.autoConvertFromEmail && actorId) {
    const result = await convertLeadWithRequirements(lead, parsed, actorId);
    await AgentLog.create({
      correlationId,
      eventType: "lead.email_reply",
      workerName: "inbound",
      agentName: "LeadConversionAgent",
      message: result.converted
        ? "Lead auto-converted from email reply"
        : `Conversion failed: ${result.error || result.message}`,
      result: result.converted ? "success" : "failed",
      meta: { inboundMessageId: messageId, fromEmail },
    });
    return result;
  }

  const event = {
    eventId: messageId || `inbound-${Date.now()}`,
    eventType: "message.replied",
    correlationId,
    payload: {
      entityType: "Lead",
      entityId: leadId.toString(),
      preview: cleanText(content).slice(0, 200),
    },
  };

  const proposal = await proposeConversion(lead, parsed, event);
  await AgentLog.create({
    correlationId,
    eventType: "lead.email_reply",
    workerName: "inbound",
    agentName: "LeadConversionAgent",
    message: proposal.proposed
      ? "Requirements complete — conversion proposed for AI Hub approval"
      : "Reply logged",
    result: "success",
    meta: { inboundMessageId: messageId, fromEmail, proposal },
  });

  return { ...proposal };
}

async function convertLeadWithRequirements(lead, requirements, actorUserId) {
  const assignedTo = await resolveAssignee(lead);
  if (!assignedTo) {
    return { error: "no_assignee", message: "Lead has no assigned employee" };
  }

  const result = await leadFacade.convertLeadToClient(
    lead._id,
    {
      priority: lead.priority || "High",
      assignedTo,
      clientFields: requirements,
    },
    { type: "user", userId: actorUserId },
    { ipAddress: null }
  );

  if (result.error) return result;

  await sendConversionAckEmail(lead, requirements);

  await AgentLog.create({
    correlationId: lead.correlationId,
    eventType: "lead.email_conversion",
    workerName: "orchestrator",
    agentName: "LeadConversionAgent",
    message: `Lead converted from email requirements (${requirements.city})`,
    result: "success",
    meta: { clientId: result.client._id.toString() },
  });

  return { converted: true, clientId: result.client._id, correlationId: result.correlationId };
}

async function proposeConversion(lead, requirements, event) {
  const pending = await agentActionService.hasPendingIntent(
    "Lead",
    lead._id,
    "propose_lead_conversion"
  );
  if (pending) return { skipped: true, reason: "pending_proposal" };

  const action = await agentActionService.createAction({
    agentName: "LeadConversionAgent",
    agentVersion: "1.0.0",
    intent: "propose_lead_conversion",
    entityType: "Lead",
    entityId: lead._id,
    correlationId: lead.correlationId,
    triggerEventId: event?.eventId,
    payload: {
      leadId: lead._id.toString(),
      leadName: lead.name,
      email: lead.email,
      requirements,
      excerpt: requirements.rawExcerpt || "",
    },
    confidence: 0.85,
    reasoning: `Email contains enough details to convert — city: ${requirements.city}, area: ${requirements.preferredArea || "—"}`,
    status: "pending_approval",
  });

  const auto = await automationService().tryAutoExecute(action);
  if (auto.executed) {
    return { proposed: true, autoConverted: true, agentActionId: action._id.toString() };
  }

  return { proposed: true, agentActionId: action._id.toString() };
}

/**
 * On inbound email reply: parse requirements and convert lead → client when complete.
 */
async function handleLeadEmailReply(event) {
  const correlationId = event.correlationId;
  const entityType = event.payload?.entityType;
  if (!correlationId || entityType !== "Lead") {
    return { skipped: true, reason: "not_lead" };
  }

  const inboundMessageId = event.payload?.externalMessageId;
  if (inboundMessageId && (await wasReplyAlreadyProcessed(inboundMessageId))) {
    return { skipped: true, reason: "already_processed_inline" };
  }

  if (await isAiPaused(correlationId)) {
    return { skipped: true, reason: "ai_paused" };
  }

  const leadId = event.payload?.entityId;
  const lead = await Lead.findById(leadId);
  if (!lead || lead.isConverted) {
    return { skipped: true, reason: "lead_converted_or_missing" };
  }

  const body = await getLatestInboundBody(correlationId, event.payload?.preview);
  const parsed = parseRequirementsFromEmail(body);

  if (!isCompleteForConversion(parsed)) {
    await AgentLog.create({
      correlationId,
      eventId: event.eventId,
      eventType: event.eventType,
      workerName: "orchestrator",
      agentName: "LeadConversionAgent",
      message: "Inbound email logged — not enough detail to auto-convert yet",
      result: "skipped",
      meta: { hasCity: Boolean(parsed.city), excerpt: cleanText(body).slice(0, 120) },
    });
    const autoReply = await sendRequestDetailsEmail(lead, parsed);
    return { skipped: true, reason: "incomplete_requirements", parsed, autoReply };
  }

  const settings = await automationService().getAutomationSettings();
  const actorId = await automationService().getAutomationActorId();

  if (settings.autoConvertFromEmail && actorId) {
    const result = await convertLeadWithRequirements(lead, parsed, actorId);
    if (result.converted) {
      return result;
    }
  }

  return proposeConversion(lead, parsed, event);
}

async function executeProposedConversion(action, userId) {
  const leadId = action.payload?.leadId || action.entityId;
  const requirements = action.payload?.requirements || {};
  const lead = await Lead.findById(leadId);
  if (!lead) return { error: "lead_not_found" };
  if (lead.isConverted) return { error: "already_converted" };

  const result = await convertLeadWithRequirements(lead, requirements, userId);
  if (result.error) return result;

  await agentActionService.markExecuted(action._id, {
    clientId: result.clientId?.toString(),
    approvedBy: userId?.toString(),
  });

  await require("../models/AgentAction").findByIdAndUpdate(action._id, {
    approvedBy: userId,
  });

  return { converted: true, clientId: result.clientId };
}

module.exports = {
  handleLeadEmailReply,
  processLeadReplyAfterInbound,
  executeProposedConversion,
  convertLeadWithRequirements,
};
