const ProposalVisit = require("../models/ProposalVisit");
const Opportunity = require("../models/Opportunity");
const AgentLog = require("../models/AgentLog");
const { getFollowUpQueue } = require("../queues/followUpQueue");
const { getProposalFollowUpDelayMs, buildProposalPublicUrl } = require("../config/opportunityDealFlow");
const { sendMailSafe, getEmailFrom } = require("../utils/smtpTransporter");
const { enqueueOutboxEvent } = require("./outboxService");
const templateService = require("./templateService");

const FOLLOW_UP_TEMPLATE = "proposal_followup_v1";

function proposalFollowUpJobId(opportunityId) {
  return `proposal-followup-${opportunityId}`;
}

async function scheduleProposalFollowUp({ opportunityId, correlationId }) {
  const queue = getFollowUpQueue();
  const jobId = proposalFollowUpJobId(opportunityId);
  const delayMs = getProposalFollowUpDelayMs();

  try {
    const existing = await queue.getJob(jobId);
    if (existing) await existing.remove();
  } catch (_) {
    /* ignore */
  }

  await queue.add(
    "proposal-follow-up",
    { opportunityId, correlationId },
    { jobId, delay: delayMs }
  );

  return { scheduled: true, delayMs, jobId };
}

async function cancelProposalFollowUp(opportunityId) {
  try {
    const job = await getFollowUpQueue().getJob(proposalFollowUpJobId(opportunityId));
    if (job) await job.remove();
  } catch (_) {
    /* ignore */
  }
}

async function hasProposalBeenViewed(opportunityId) {
  return Boolean(await ProposalVisit.exists({ opportunityId }));
}

async function runProposalFollowUp({ opportunityId, correlationId }) {
  const opportunity = await Opportunity.findById(opportunityId)
    .populate("client", "name email contactPerson correlationId")
    .populate("property", "name city");

  if (!opportunity?.proposalEmailSentAt) {
    return { skipped: true, reason: "proposal_not_sent" };
  }

  if (await hasProposalBeenViewed(opportunityId)) {
    return { skipped: true, reason: "already_viewed" };
  }

  const client = opportunity.client;
  const from = getEmailFrom();
  if (!from || !client?.email) {
    return { skipped: true, reason: "no_email" };
  }

  const link = buildProposalPublicUrl(opportunityId);
  const template = await templateService.getTemplate(FOLLOW_UP_TEMPLATE);
  const rendered = template
    ? templateService.renderTemplate(template, {
        clientName: client.contactPerson || client.name,
        propertyName: opportunity.property?.name || "Property",
        city: opportunity.property?.city || "",
        proposalLink: link,
      })
    : {
        subject: `Reminder — property proposal for ${opportunity.property?.name || "your requirement"}`,
        body: `Hi ${client.contactPerson || client.name},\n\nPlease review your property proposal:\n${link}\n\nRewa Realtors Team`,
      };

  const sendResult = await sendMailSafe({
    from,
    to: client.email,
    subject: rendered.subject,
    text: rendered.body,
  });

  const corr = correlationId || client.correlationId;

  if (corr) {
    await enqueueOutboxEvent({
      eventType: "proposal.follow_up_sent",
      aggregateType: "Opportunity",
      aggregateId: opportunityId,
      correlationId: corr,
      schemaVersion: 1,
      metadata: { actor: "agent:ProposalAgent" },
      payload: {
        opportunityId,
        correlationId: corr,
        sent: sendResult.sent,
      },
    });
  }

  await AgentLog.create({
    correlationId: corr,
    eventType: "proposal.follow_up_sent",
    workerName: "follow-up-sequence",
    agentName: "ProposalAgent",
    message: sendResult.sent
      ? "Proposal follow-up email sent (SLA)"
      : `Follow-up skipped: ${sendResult.reason || "send failed"}`,
    result: sendResult.sent ? "success" : "skipped",
  });

  return {
    followUpSent: sendResult.sent,
    correlationId: corr,
    readyForSiteVisitProposal: true,
  };
}

module.exports = {
  scheduleProposalFollowUp,
  cancelProposalFollowUp,
  hasProposalBeenViewed,
  runProposalFollowUp,
  proposalFollowUpJobId,
};
