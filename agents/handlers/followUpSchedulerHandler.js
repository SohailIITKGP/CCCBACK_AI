const Lead = require("../../models/Lead");
const AgentLog = require("../../models/AgentLog");
const agentActionService = require("../../services/agentActionService");
const processManagerService = require("../../services/processManagerService");
const { scheduleLeadContactSlaCheck } = require("../../services/slaEngineService");
const { isAiPaused } = require("../../services/aiPauseService");
const {
  AGENT_NAME,
  AGENT_VERSION,
  startSequence,
  draftAndQueueEmail,
} = require("../../services/leadFollowUpSequenceService");
const { getDetailsRequestDelayMinutes } = require("../../config/leadFollowUpSequence");

async function handleLeadQualified(event) {
  const leadId = event.payload?.leadId || event.aggregateId;
  const lead = await Lead.findById(leadId);
  if (!lead || !lead.correlationId) return { skipped: true };

  if (await isAiPaused(lead.correlationId)) {
    return { skipped: true, reason: "ai_paused" };
  }

  if (!lead.email) {
    await AgentLog.create({
      correlationId: lead.correlationId,
      eventId: event.eventId,
      eventType: event.eventType,
      workerName: "orchestrator",
      agentName: AGENT_NAME,
      message: "Skipped follow-up draft — lead has no email",
      result: "skipped",
    });
    return { skipped: true, reason: "no_email" };
  }

  if (lead.aiFollowUpState?.status === "active") {
    return { skipped: true, reason: "sequence_already_active" };
  }

  const pending = await agentActionService.hasPendingSendEmail("Lead", lead._id);
  if (pending) return { skipped: true, reason: "pending_exists" };

  await processManagerService.onLeadQualified(lead.correlationId);

  await startSequence(lead, event.eventId);

  const result = await draftAndQueueEmail({
    lead,
    stepIndex: 0,
    templateId: "lead_welcome_v1",
    triggerEventId: event.eventId,
    triggerEventType: event.eventType,
  });

  await scheduleLeadContactSlaCheck(lead);

  await AgentLog.create({
    correlationId: lead.correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
    message: `Thank-you sent; details request in ${getDetailsRequestDelayMinutes()} min + Day 3 & Day 7 scheduled`,
    result: "success",
    meta: { agentActionId: result.agentActionId, autoSent: result.autoSent },
  });

  return {
    drafted: true,
    autoSent: result.autoSent,
    agentActionId: result.agentActionId,
    sequenceStarted: true,
  };
}

module.exports = {
  AGENT_NAME,
  handleLeadQualified,
};
