const Opportunity = require("../../models/Opportunity");
const DomainEvent = require("../../models/DomainEvent");
const AgentLog = require("../../models/AgentLog");
const agentActionService = require("../../services/agentActionService");
const { enqueueOutboxEvent } = require("../../services/outboxService");
const { shouldProposeSiteVisit, buildSiteVisitProposal } = require("../../config/dealRules");
const processManagerService = require("../../services/processManagerService");
const { isAiPaused } = require("../../services/aiPauseService");

const AGENT_NAME = "DealOrchestratorAgent";
const AGENT_VERSION = "1.0.0";

async function proposeSiteVisitFromEvent(event) {
  const opportunityId = event.payload?.opportunityId || event.aggregateId;
  const opportunity = await Opportunity.findById(opportunityId)
    .populate("client", "name correlationId")
    .populate("property", "name city");

  if (!opportunity) return { skipped: true, reason: "opportunity_not_found" };

  const correlationId =
    event.correlationId ||
    event.payload?.correlationId ||
    opportunity.client?.correlationId;

  if (!correlationId) return { skipped: true, reason: "no_correlation_id" };

  if (await isAiPaused(correlationId)) {
    return { skipped: true, reason: "ai_paused" };
  }

  if (!shouldProposeSiteVisit(opportunity)) {
    return { skipped: true, reason: "not_eligible_for_site_visit" };
  }

  const pending = await agentActionService.hasPendingIntent(
    "Opportunity",
    opportunity._id,
    "propose_site_visit"
  );
  if (pending) return { skipped: true, reason: "pending_exists" };

  const alreadyProposed = await DomainEvent.exists({
    correlationId,
    eventType: "deal.site_visit_proposed",
    "payload.opportunityId": opportunity._id.toString(),
  });
  if (alreadyProposed) return { skipped: true, reason: "already_proposed" };

  const proposal = buildSiteVisitProposal(opportunity);

  const action = await agentActionService.createAction({
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
    intent: "propose_site_visit",
    entityType: "Opportunity",
    entityId: opportunity._id,
    correlationId,
    triggerEventId: event.eventId,
    payload: {
      opportunityId: opportunity._id.toString(),
      clientId: opportunity.client?._id?.toString(),
      propertyId: opportunity.property?._id?.toString(),
      clientName: opportunity.client?.name,
      propertyName: opportunity.property?.name,
      currentStatus: opportunity.status,
      ...proposal,
    },
    confidence: 0.85,
    reasoning: `Propose site visit on ${new Date(proposal.siteVisitDate).toLocaleDateString("en-IN")}`,
    status: "pending_approval",
  });

  await enqueueOutboxEvent({
    eventType: "deal.site_visit_proposed",
    aggregateType: "Opportunity",
    aggregateId: opportunity._id,
    correlationId,
    causationId: event.eventId,
    schemaVersion: 1,
    metadata: { actor: `agent:${AGENT_NAME}` },
    payload: {
      opportunityId: opportunity._id.toString(),
      agentActionId: action._id.toString(),
      proposedStatus: proposal.proposedStatus,
      siteVisitDate: proposal.siteVisitDate,
      correlationId,
    },
  });

  await enqueueOutboxEvent({
    eventType: "agent.action_proposed",
    aggregateType: "AgentAction",
    aggregateId: action._id,
    correlationId,
    causationId: event.eventId,
    schemaVersion: 1,
    metadata: { actor: `agent:${AGENT_NAME}` },
    payload: {
      agentActionId: action._id.toString(),
      agentName: AGENT_NAME,
      intent: "propose_site_visit",
      correlationId,
    },
  });

  await AgentLog.create({
    correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    message: `Proposed site visit for opportunity ${opportunity._id}`,
    result: "success",
    meta: { agentActionId: action._id.toString() },
  });

  return { proposed: true, agentActionId: action._id.toString() };
}

async function handleOpportunityCreated(event) {
  const opportunityId = event.payload?.opportunityId || event.aggregateId;
  const correlationId = event.correlationId || event.payload?.correlationId;

  if (correlationId && opportunityId) {
    await processManagerService.onOpportunityCreated(correlationId, opportunityId);
  }

  return {
    skipped: true,
    reason: "awaiting_proposal_engagement",
    message: "Site visit is proposed after proposal is viewed or SLA follow-up is sent",
  };
}

async function handleProposalEngagementReady(event) {
  return proposeSiteVisitFromEvent(event);
}

module.exports = {
  AGENT_NAME,
  handleOpportunityCreated,
  handleProposalEngagementReady,
  proposeSiteVisitFromEvent,
};
