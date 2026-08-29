const ProposalVisit = require("../models/ProposalVisit");
const Opportunity = require("../models/Opportunity");
const AgentLog = require("../models/AgentLog");
const FollowUpTask = require("../models/FollowUpTask");
const { getFollowUpQueue } = require("../queues/followUpQueue");
const { getProposalStaleDelayMs } = require("../config/opportunityDealFlow");
const { enqueueOutboxEvent } = require("./outboxService");
const { raiseException } = require("./exceptionCenterService");
const { hasProposalBeenViewed, cancelProposalFollowUp } = require("./opportunityProposalFollowUpService");

function proposalStaleJobId(opportunityId) {
  return `proposal-stale-${opportunityId}`;
}

async function scheduleProposalStaleCheck({ opportunityId, correlationId }) {
  const queue = getFollowUpQueue();
  const jobId = proposalStaleJobId(opportunityId);
  const delayMs = getProposalStaleDelayMs();

  try {
    const existing = await queue.getJob(jobId);
    if (existing) await existing.remove();
  } catch (_) {
    /* ignore */
  }

  await queue.add(
    "proposal-stale-check",
    { opportunityId, correlationId },
    { jobId, delay: delayMs }
  );

  return { scheduled: true, delayMs, jobId };
}

async function cancelProposalStaleCheck(opportunityId) {
  try {
    const job = await getFollowUpQueue().getJob(proposalStaleJobId(opportunityId));
    if (job) await job.remove();
  } catch (_) {
    /* ignore */
  }
}

async function runProposalStaleCheck({ opportunityId, correlationId }) {
  const opportunity = await Opportunity.findById(opportunityId)
    .populate("client", "name email assignedTo whoConverted correlationId")
    .populate("property", "name city");

  if (!opportunity?.proposalEmailSentAt) {
    return { skipped: true, reason: "proposal_not_sent" };
  }

  if (opportunity.proposalStatus === "superseded") {
    return { skipped: true, reason: "superseded" };
  }

  if (await hasProposalBeenViewed(opportunityId)) {
    return { skipped: true, reason: "already_viewed" };
  }

  const client = opportunity.client;
  const corr = correlationId || client?.correlationId;

  await raiseException({
    type: "proposal_stale",
    correlationId: corr,
    entityType: "Opportunity",
    entityId: opportunity._id,
    title: `Proposal not opened — ${client?.name || "Client"}`,
    description: `${opportunity.property?.name || "Property"} proposal sent ${new Date(opportunity.proposalEmailSentAt).toLocaleDateString("en-IN")} — client has not opened the link.`,
    dedupeKey: `proposal_stale:${opportunityId}`,
    payload: {
      opportunityId,
      clientId: client?._id?.toString(),
      propertyName: opportunity.property?.name,
    },
    sourceEventType: "proposal.stale",
  });

  const assigneeId = client?.assignedTo || client?.whoConverted;
  if (assigneeId) {
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 1);
    await FollowUpTask.create({
      title: `Follow up — proposal not opened (${client?.name || "Client"})`,
      description: `Client has not opened the proposal for ${opportunity.property?.name || "property"}. Call or WhatsApp the proposal link.`,
      assignedTo: assigneeId,
      entityType: "opportunity",
      opportunity: opportunity._id,
      clientName: client?.name || "",
      propertyName: opportunity.property?.name || "",
      opportunityStatus: opportunity.status,
      taskType: "follow_up",
      dueDate,
      sourceKey: `proposal-stale:${opportunityId}`,
      meta: { correlationId: corr, opportunityId },
    }).catch(() => {});
  }

  if (corr) {
    await enqueueOutboxEvent({
      eventType: "proposal.stale",
      aggregateType: "Opportunity",
      aggregateId: opportunityId,
      correlationId: corr,
      schemaVersion: 1,
      metadata: { actor: "system:proposal_stale" },
      payload: {
        opportunityId,
        correlationId: corr,
        clientId: client?._id?.toString(),
        daysSinceSent: Math.floor(
          (Date.now() - new Date(opportunity.proposalEmailSentAt).getTime()) / (24 * 60 * 60 * 1000)
        ),
      },
    });
  }

  await AgentLog.create({
    correlationId: corr,
    eventType: "proposal.stale",
    workerName: "follow-up-sequence",
    agentName: "ProposalStaleAgent",
    message: "Proposal marked stale — client has not opened link",
    result: "success",
    meta: { opportunityId },
  });

  return { stale: true, opportunityId };
}

async function cancelAllProposalTimers(opportunityId) {
  await cancelProposalFollowUp(opportunityId);
  await cancelProposalStaleCheck(opportunityId);
}

module.exports = {
  scheduleProposalStaleCheck,
  cancelProposalStaleCheck,
  runProposalStaleCheck,
  cancelAllProposalTimers,
  proposalStaleJobId,
};
