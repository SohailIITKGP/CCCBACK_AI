const Opportunity = require("../models/Opportunity");
const AgentLog = require("../models/AgentLog");
const { sendMailSafe, getEmailFrom } = require("../utils/smtpTransporter");
const { logAutomationEvent } = require("../utils/auditLogger");
const { buildProposalPublicUrl } = require("../config/opportunityDealFlow");
const { enqueueOutboxEvent } = require("./outboxService");
const conversationService = require("./conversationService");
const templateService = require("./templateService");
const { scheduleProposalFollowUp } = require("./opportunityProposalFollowUpService");
const { scheduleProposalStaleCheck } = require("./opportunityProposalStaleService");

const PROPOSAL_TEMPLATE = "client_proposal_share_v1";

async function loadOpportunity(opportunityId) {
  return Opportunity.findById(opportunityId)
    .populate("client", "name email correlationId contactPerson")
    .populate("property", "name city roadName address expectedRent exactArea area category");
}

async function markProposalVerified(opportunity, actorUserId = null) {
  if (opportunity.verifiedProposal) return opportunity;
  opportunity.verifiedProposal = true;
  opportunity.verifiedProposalAt = new Date();
  if (actorUserId) opportunity.verifiedProposalBy = actorUserId;
  await opportunity.save();
  return opportunity;
}

async function sendProposalToClient({
  opportunityId,
  actorUserId = null,
  source = "automation",
  skipIfAlreadySent = true,
}) {
  let opportunity = await loadOpportunity(opportunityId);
  if (!opportunity) {
    return { error: "opportunity_not_found" };
  }

  if (opportunity.proposalStatus === "superseded") {
    return { error: "proposal_superseded", message: "This proposal has been replaced with an updated option." };
  }

  const client = opportunity.client;
  if (!client?.email) {
    return { error: "client_no_email", message: "Client has no email address" };
  }

  if (skipIfAlreadySent && opportunity.proposalEmailSentAt) {
    return { skipped: true, reason: "already_sent" };
  }

  const from = getEmailFrom();
  if (!from) {
    return { error: "email_not_configured" };
  }

  await markProposalVerified(opportunity, actorUserId);
  opportunity = await loadOpportunity(opportunityId);

  const property = opportunity.property;
  const proposalLink = buildProposalPublicUrl(opportunity._id.toString());
  const template = await templateService.getTemplate(PROPOSAL_TEMPLATE);

  let subject;
  let body;
  if (template) {
    const rendered = templateService.renderTemplate(template, {
      clientName: client.contactPerson || client.name,
      propertyName: property?.name || "Property",
      city: property?.city || client.city || "",
      proposalLink,
      expectedRent: property?.expectedRent || "",
      area: property?.exactArea || property?.area || "",
    });
    subject = rendered.subject;
    body = rendered.body;
  } else {
    subject = `Proposal — ${property?.name || "Property"} @ ${property?.city || ""}`;
    body = `Hi ${client.contactPerson || client.name},\n\nPlease review your property proposal:\n${proposalLink}\n\nRewa Realtors Team`;
  }

  const sendResult = await sendMailSafe({
    from,
    to: client.email,
    subject,
    text: body,
  });

  if (!sendResult.sent) {
    return { error: "send_failed", reason: sendResult.reason };
  }

  opportunity.proposalEmailSentAt = new Date();
  if (actorUserId) opportunity.proposalEmailSentBy = actorUserId;
  await opportunity.save();

  const correlationId = client.correlationId;

  if (correlationId) {
    await conversationService.recordOutboundMessage({
      correlationId,
      entityType: "Client",
      entityId: client._id,
      channel: "email",
      content: body,
      subject,
      templateId: PROPOSAL_TEMPLATE,
      externalMessageId: sendResult.messageId,
      actor: source === "automation" ? "agent:ProposalAgent" : `user:${actorUserId}`,
    });

    await enqueueOutboxEvent({
      eventType: "proposal.sent",
      aggregateType: "Opportunity",
      aggregateId: opportunity._id,
      correlationId,
      schemaVersion: 1,
      metadata: { actor: source === "automation" ? "agent:ProposalAgent" : "user" },
      payload: {
        opportunityId: opportunity._id.toString(),
        clientId: client._id.toString(),
        propertyId: property?._id?.toString(),
        correlationId,
        proposalLink,
      },
    });
  }

  await scheduleProposalFollowUp({
    opportunityId: opportunity._id.toString(),
    correlationId,
  });

  await scheduleProposalStaleCheck({
    opportunityId: opportunity._id.toString(),
    correlationId,
  });

  await logAutomationEvent({
    action: "data_update",
    resource: "Opportunity",
    resourceId: opportunity._id,
    entityName: `${client.name} – ${property?.name || "Property"}`,
    details: {
      action: "proposal_sent",
      clientEmail: client.email,
      propertyName: property?.name,
      source,
    },
  });

  await AgentLog.create({
    correlationId,
    eventType: "proposal.sent",
    workerName: "orchestrator",
    agentName: "ProposalAgent",
    message: `Proposal emailed to ${client.email}`,
    result: "success",
    meta: { opportunityId: opportunity._id.toString(), source },
  });

  return {
    sent: true,
    opportunityId: opportunity._id.toString(),
    correlationId,
    proposalLink,
    messageId: sendResult.messageId,
  };
}

/**
 * Property share email already included the proposal link — mark sent without a second email.
 */
async function recordProposalDeliveredViaPropertyShare({
  opportunityId,
  correlationId,
  actorUserId = null,
  proposalLink,
}) {
  let opportunity = await loadOpportunity(opportunityId);
  if (!opportunity) return { error: "opportunity_not_found" };

  if (opportunity.proposalEmailSentAt) {
    return { skipped: true, reason: "already_sent" };
  }

  await markProposalVerified(opportunity, actorUserId);
  opportunity = await loadOpportunity(opportunityId);

  opportunity.proposalEmailSentAt = new Date();
  if (actorUserId) opportunity.proposalEmailSentBy = actorUserId;
  await opportunity.save();

  const client = opportunity.client;
  const property = opportunity.property;
  const corr = correlationId || client?.correlationId;
  const link = proposalLink || buildProposalPublicUrl(opportunityId);

  if (corr) {
    await enqueueOutboxEvent({
      eventType: "proposal.sent",
      aggregateType: "Opportunity",
      aggregateId: opportunity._id,
      correlationId: corr,
      schemaVersion: 1,
      metadata: { actor: "agent:PropertyMatchingAgent" },
      payload: {
        opportunityId: opportunity._id.toString(),
        clientId: client?._id?.toString(),
        propertyId: property?._id?.toString(),
        correlationId: corr,
        proposalLink: link,
        source: "property_share_email",
      },
    });
  }

  await scheduleProposalFollowUp({
    opportunityId: opportunity._id.toString(),
    correlationId: corr,
  });

  await AgentLog.create({
    correlationId: corr,
    eventType: "proposal.sent",
    workerName: "orchestrator",
    agentName: "ProposalAgent",
    message: `Proposal link included in property share email to ${client?.email || "client"}`,
    result: "success",
    meta: { opportunityId, source: "property_share_email" },
  });

  return { recorded: true, opportunityId, correlationId: corr, proposalLink: link };
}

module.exports = {
  PROPOSAL_TEMPLATE,
  sendProposalToClient,
  buildProposalPublicUrl,
  markProposalVerified,
  recordProposalDeliveredViaPropertyShare,
};
