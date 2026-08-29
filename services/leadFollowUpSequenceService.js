const Lead = require("../models/Lead");
const AgentLog = require("../models/AgentLog");
const DomainEvent = require("../models/DomainEvent");
const agentActionService = require("./agentActionService");
const { tryAutoExecute } = require("./agentAutomationService");
const templateService = require("./templateService");
const { enqueueOutboxEvent } = require("./outboxService");
const {
  LEAD_FOLLOW_UP_STEPS,
  getStepConfig,
  getDelayMsForStep,
  getDetailsRequestDelayMinutes,
  isSequenceEnabled,
} = require("../config/leadFollowUpSequence");
const { getFollowUpQueue, followUpJobId } = require("../queues/followUpQueue");
const { isAiPaused } = require("./aiPauseService");

const AGENT_NAME = "FollowUpSchedulerAgent";
const AGENT_VERSION = "1.1.0";

function buildTemplateVariables(lead, stepIndex = 0) {
  if (stepIndex === 0) {
    return {
      clientName: lead.contactPerson || lead.name,
      personalizedLine: lead.remarks
        ? `Regarding your enquiry: ${String(lead.remarks).slice(0, 200)}`
        : "We appreciate you reaching out to us.",
      city: lead.state || "your preferred location",
    };
  }

  return {
    clientName: lead.contactPerson || lead.name,
    personalizedLine: lead.remarks
      ? `You mentioned: ${String(lead.remarks).slice(0, 200)}`
      : "We have not received your full requirement details yet.",
    city: lead.state || "your preferred location",
  };
}

function shouldSkipLeadForFollowUp(lead) {
  if (!lead) return { skip: true, reason: "lead_not_found" };
  if (!lead.email) return { skip: true, reason: "no_email" };
  if (lead.isConverted || lead.lifecycleState === "CONVERTED") {
    return { skip: true, reason: "converted" };
  }
  if (lead.aiFollowUpState?.status === "cancelled") {
    return { skip: true, reason: "sequence_cancelled" };
  }
  if (lead.aiFollowUpState?.status === "completed") {
    return { skip: true, reason: "sequence_completed" };
  }
  return { skip: false };
}

async function hasLeadReplied(correlationId) {
  if (!correlationId) return false;
  const replied = await DomainEvent.exists({
    correlationId,
    eventType: "message.replied",
  });
  return Boolean(replied);
}

async function scheduleFutureSteps(lead, startedAt = new Date()) {
  const queue = getFollowUpQueue();
  const baseMs = startedAt.getTime();

  for (const step of LEAD_FOLLOW_UP_STEPS) {
    if (step.step === 0) continue;

    const delayMs = Math.max(0, baseMs + getDelayMsForStep(step.step) - Date.now());
    const jobId = followUpJobId(lead._id.toString(), step.step);

    try {
      const existing = await queue.getJob(jobId);
      if (existing) await existing.remove();
    } catch (_) {
      /* ignore */
    }

    await queue.add(
      "send-sequence-step",
      {
        leadId: lead._id.toString(),
        correlationId: lead.correlationId,
        stepIndex: step.step,
        templateId: step.templateId,
      },
      { jobId, delay: delayMs }
    );
  }

  const lastStep = LEAD_FOLLOW_UP_STEPS[LEAD_FOLLOW_UP_STEPS.length - 1];
  const nextStepAt = new Date(baseMs + getDelayMsForStep(lastStep.step));

  await Lead.findByIdAndUpdate(lead._id, {
    "aiFollowUpState.nextStepAt": nextStepAt,
  });

  return { scheduled: LEAD_FOLLOW_UP_STEPS.length - 1, nextStepAt };
}

async function startSequence(lead, triggerEventId) {
  if (!isSequenceEnabled()) return { skipped: true, reason: "sequence_disabled" };

  const skip = shouldSkipLeadForFollowUp(lead);
  if (skip.skip) return { skipped: true, reason: skip.reason };

  if (lead.aiFollowUpState?.status === "active") {
    return { skipped: true, reason: "sequence_already_active" };
  }

  const startedAt = new Date();
  await Lead.findByIdAndUpdate(lead._id, {
    aiFollowUpState: {
      status: "active",
      currentStep: 0,
      stepsCompleted: 0,
      startedAt,
      lastStepAt: null,
      nextStepAt: null,
      cancelledAt: null,
      cancelReason: null,
      completedAt: null,
    },
  });

  const scheduleResult = await scheduleFutureSteps(lead, startedAt);

  await AgentLog.create({
    correlationId: lead.correlationId,
    eventId: triggerEventId,
    eventType: "lead.qualified",
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
    message: `Follow-up sequence started (thank-you now + details in ${getDetailsRequestDelayMinutes()} min + Day 3 + Day 7)`,
    result: "success",
    meta: { scheduledSteps: scheduleResult.scheduled },
  });

  return { started: true, ...scheduleResult };
}

async function cancelSequence(leadId, reason = "cancelled") {
  if (!leadId) return { skipped: true };

  const lead = await Lead.findById(leadId);
  if (!lead) return { skipped: true, reason: "lead_not_found" };

  if (lead.aiFollowUpState?.status !== "active") {
    return { skipped: true, reason: "not_active" };
  }

  const queue = getFollowUpQueue();
  for (const step of LEAD_FOLLOW_UP_STEPS) {
    if (step.step === 0) continue;
    try {
      const job = await queue.getJob(followUpJobId(leadId.toString(), step.step));
      if (job) await job.remove();
    } catch (_) {
      /* ignore */
    }
  }

  await Lead.findByIdAndUpdate(leadId, {
    "aiFollowUpState.status": "cancelled",
    "aiFollowUpState.cancelledAt": new Date(),
    "aiFollowUpState.cancelReason": reason,
    "aiFollowUpState.nextStepAt": null,
  });

  await AgentLog.create({
    correlationId: lead.correlationId,
    eventType: "follow_up.cancelled",
    workerName: "follow-up-sequence",
    agentName: AGENT_NAME,
    message: `Follow-up sequence cancelled (${reason})`,
    result: "success",
  });

  return { cancelled: true, reason };
}

async function markStepCompleted(leadId, stepIndex) {
  const isFinal = stepIndex >= LEAD_FOLLOW_UP_STEPS.length - 1;
  const update = {
    "aiFollowUpState.currentStep": stepIndex,
    "aiFollowUpState.stepsCompleted": stepIndex + 1,
    "aiFollowUpState.lastStepAt": new Date(),
  };

  if (isFinal) {
    update["aiFollowUpState.status"] = "completed";
    update["aiFollowUpState.completedAt"] = new Date();
    update["aiFollowUpState.nextStepAt"] = null;
  }

  await Lead.findByIdAndUpdate(leadId, update);

  if (isFinal) {
    const { handleLeadNurtureExhausted } = require("./leadNurtureExhaustedService");
    await handleLeadNurtureExhausted(leadId).catch((err) =>
      console.error("[follow-up] nurture exhausted handler failed:", err.message)
    );
  }
}

async function draftAndQueueEmail({
  lead,
  stepIndex,
  templateId,
  triggerEventId,
  triggerEventType = "lead.qualified",
}) {
  const step = getStepConfig(stepIndex);
  if (!step) return { error: "invalid_step" };

  const resolvedTemplateId = templateId || step.templateId;
  const template = await templateService.getTemplate(resolvedTemplateId);
  if (!template) {
    throw new Error(`Template not found: ${resolvedTemplateId}`);
  }

  const rendered = templateService.renderTemplate(
    template,
    buildTemplateVariables(lead, stepIndex)
  );

  const action = await agentActionService.createAction({
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
    intent: "send_email",
    entityType: "Lead",
    entityId: lead._id,
    correlationId: lead.correlationId,
    triggerEventId,
    payload: {
      channel: "email",
      templateId: resolvedTemplateId,
      sequenceStep: stepIndex,
      sequenceLabel: step.label,
      toEmail: lead.email,
      subject: rendered.subject,
      body: rendered.body,
      variables: rendered.variables,
    },
    confidence: 0.9,
    reasoning: `${step.label} — ${resolvedTemplateId}`,
    status: "pending_approval",
  });

  await enqueueOutboxEvent({
    eventType: "message.drafted",
    aggregateType: "Lead",
    aggregateId: lead._id,
    correlationId: lead.correlationId,
    causationId: triggerEventId,
    schemaVersion: 1,
    metadata: { actor: `agent:${AGENT_NAME}` },
    payload: {
      leadId: lead._id.toString(),
      correlationId: lead.correlationId,
      agentActionId: action._id.toString(),
      templateId: resolvedTemplateId,
      sequenceStep: stepIndex,
      toEmail: lead.email,
    },
  });

  await enqueueOutboxEvent({
    eventType: "agent.action_proposed",
    aggregateType: "AgentAction",
    aggregateId: action._id,
    correlationId: lead.correlationId,
    causationId: triggerEventId,
    schemaVersion: 1,
    metadata: { actor: `agent:${AGENT_NAME}` },
    payload: {
      agentActionId: action._id.toString(),
      agentName: AGENT_NAME,
      intent: "send_email",
      correlationId: lead.correlationId,
      sequenceStep: stepIndex,
    },
  });

  await markStepCompleted(lead._id, stepIndex);

  const auto = await tryAutoExecute(action);

  return {
    drafted: true,
    agentActionId: action._id.toString(),
    autoSent: Boolean(auto.executed),
    stepIndex,
    templateId: resolvedTemplateId,
  };
}

async function runScheduledStep({ leadId, stepIndex, templateId, correlationId }) {
  const lead = await Lead.findById(leadId);
  const skip = shouldSkipLeadForFollowUp(lead);
  if (skip.skip) {
    if (lead && lead.aiFollowUpState?.status === "active") {
      await cancelSequence(leadId, skip.reason);
    }
    return { skipped: true, reason: skip.reason };
  }

  if (await isAiPaused(lead.correlationId)) {
    return { skipped: true, reason: "ai_paused" };
  }

  if (await hasLeadReplied(lead.correlationId)) {
    await cancelSequence(leadId, "replied");
    return { skipped: true, reason: "replied" };
  }

  const pending = await agentActionService.hasPendingSendEmail("Lead", lead._id);
  if (pending) return { skipped: true, reason: "pending_email_exists" };

  const step = getStepConfig(stepIndex);
  if (!step) return { skipped: true, reason: "invalid_step" };

  const result = await draftAndQueueEmail({
    lead,
    stepIndex,
    templateId: templateId || step.templateId,
    triggerEventId: `followup-step-${leadId}-${stepIndex}`,
    triggerEventType: "follow_up.scheduled",
  });

  await AgentLog.create({
    correlationId: lead.correlationId || correlationId,
    eventType: "follow_up.scheduled",
    workerName: "follow-up-sequence",
    agentName: AGENT_NAME,
    message: `Scheduled ${step.label} drafted for approval`,
    result: "success",
    meta: {
      stepIndex,
      agentActionId: result.agentActionId,
      autoSent: result.autoSent,
    },
  });

  return result;
}

module.exports = {
  AGENT_NAME,
  AGENT_VERSION,
  buildTemplateVariables,
  startSequence,
  cancelSequence,
  draftAndQueueEmail,
  runScheduledStep,
  hasLeadReplied,
};
