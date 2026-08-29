const AgentLog = require("../../models/AgentLog");
const { isAiPaused } = require("../../services/aiPauseService");
const { sendProposalToClient } = require("../../services/opportunityProposalService");
const automationService = require("../../services/agentAutomationService");

const AGENT_NAME = "ProposalAgent";
const AGENT_VERSION = "1.0.0";

async function handleOpportunityCreated(event) {
  const opportunityId = event.payload?.opportunityId || event.aggregateId;
  const correlationId = event.correlationId || event.payload?.correlationId;

  if (!opportunityId) return { skipped: true, reason: "no_opportunity_id" };
  if (correlationId && (await isAiPaused(correlationId))) {
    return { skipped: true, reason: "ai_paused" };
  }

  const settings = await automationService.getAutomationSettings();
  if (!settings.autoSendProposalEmail) {
    await AgentLog.create({
      correlationId,
      eventId: event.eventId,
      eventType: event.eventType,
      workerName: "orchestrator",
      agentName: AGENT_NAME,
      message: "Proposal send skipped — autoSendProposalEmail is OFF",
      result: "skipped",
    });
    return { skipped: true, reason: "automation_off" };
  }

  const actorId = await automationService.getAutomationActorId();
  const result = await sendProposalToClient({
    opportunityId,
    actorUserId: actorId,
    source: "automation",
  });

  if (result.error) {
    await AgentLog.create({
      correlationId,
      eventType: event.eventType,
      workerName: "orchestrator",
      agentName: AGENT_NAME,
      message: `Proposal send failed: ${result.error}`,
      result: "failed",
      meta: result,
    });
    return result;
  }

  if (result.skipped) {
    return result;
  }

  await AgentLog.create({
    correlationId: result.correlationId || correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
    message: "Proposal sent; SLA follow-up scheduled",
    result: "success",
    meta: { opportunityId, proposalLink: result.proposalLink },
  });

  return { sent: true, ...result };
}

module.exports = {
  AGENT_NAME,
  handleOpportunityCreated,
};
