const Conversation = require("../models/Conversation");
const AgentLog = require("../models/AgentLog");
const templateService = require("./templateService");
const conversationService = require("./conversationService");
const { sendMailSafe, getEmailFrom } = require("../utils/smtpTransporter");

const REQUEST_DETAILS_TEMPLATE = "lead_request_details_v1";
const CONVERSION_ACK_TEMPLATE = "lead_conversion_ack_v1";
const COOLDOWN_MS = parseInt(process.env.LEAD_REQUEST_DETAILS_COOLDOWN_MS || "3600000", 10);

async function recentlySentTemplate(correlationId, templateId) {
  const conv = await Conversation.findOne({ correlationId }).select("channels").lean();
  const cutoff = Date.now() - COOLDOWN_MS;
  return (conv?.channels || []).some(
    (c) =>
      c.direction === "outbound" &&
      c.templateId === templateId &&
      new Date(c.timestamp).getTime() > cutoff
  );
}

async function sendTemplatedReply({
  lead,
  templateId,
  variables,
  correlationId,
  logMessage,
}) {
  const from = getEmailFrom();
  if (!from || !lead?.email) {
    return { skipped: true, reason: "no_smtp_or_email" };
  }

  if (await recentlySentTemplate(correlationId, templateId)) {
    return { skipped: true, reason: "cooldown" };
  }

  const template = await templateService.getTemplate(templateId);
  if (!template) {
    return { skipped: true, reason: "template_missing" };
  }

  const rendered = templateService.renderTemplate(template, variables);
  const sendResult = await sendMailSafe({
    from,
    to: lead.email,
    subject: rendered.subject,
    text: rendered.body,
  });

  if (!sendResult.sent) {
    return { error: "send_failed", reason: sendResult.reason };
  }

  await conversationService.recordOutboundMessage({
    correlationId,
    entityType: "Lead",
    entityId: lead._id,
    channel: "email",
    content: rendered.body,
    subject: rendered.subject,
    templateId,
    externalMessageId: sendResult.messageId,
    actor: "agent:LeadConversionAgent",
  });

  await AgentLog.create({
    correlationId,
    eventType: "message.sent",
    workerName: "orchestrator",
    agentName: "LeadConversionAgent",
    message: logMessage,
    result: "success",
    meta: { templateId, toEmail: lead.email },
  });

  return { sent: true, templateId };
}

async function sendRequestDetailsEmail(lead, parsed = {}) {
  const missing = [];
  if (!parsed.city) missing.push("City");
  if (!parsed.preferredArea && !parsed.otherPreferredAreas) missing.push("Preferred area / locality");
  if (!parsed.minimumArea && !parsed.requirement && !parsed.kindOfBusiness) {
    missing.push("Property size (sqft) or business type");
  }

  return sendTemplatedReply({
    lead,
    templateId: REQUEST_DETAILS_TEMPLATE,
    correlationId: lead.correlationId,
    variables: {
      clientName: lead.contactPerson || lead.name,
      personalizedLine:
        missing.length > 0
          ? `Please share: ${missing.join(", ")}.`
          : "Please share your city, area, size, and budget.",
    },
    logMessage: "Auto-replied — requested missing requirement details",
  });
}

async function sendConversionAckEmail(lead, requirements = {}) {
  const summary = [
    requirements.city && `City: ${requirements.city}`,
    requirements.preferredArea && `Preferred area: ${requirements.preferredArea}`,
    requirements.minimumArea && `Required size: ${requirements.minimumArea} sqft`,
    requirements.expectedRent && `Budget: ${requirements.expectedRent}`,
    requirements.kindOfBusiness && `Type of business: ${requirements.kindOfBusiness}`,
  ]
    .filter(Boolean)
    .join("\n");

  return sendTemplatedReply({
    lead,
    templateId: CONVERSION_ACK_TEMPLATE,
    correlationId: lead.correlationId,
    variables: {
      clientName: lead.contactPerson || lead.name,
      personalizedLine: summary || "We received your requirements and are matching properties for you.",
      city: requirements.city || "",
    },
    logMessage: "Auto-replied — confirmed requirements received, matching properties",
  });
}

module.exports = {
  sendRequestDetailsEmail,
  sendConversionAckEmail,
  REQUEST_DETAILS_TEMPLATE,
  CONVERSION_ACK_TEMPLATE,
};
