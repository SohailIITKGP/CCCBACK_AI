const Lead = require("../models/Lead");
const FollowUpTask = require("../models/FollowUpTask");
const AgentLog = require("../models/AgentLog");
const { enqueueOutboxEvent } = require("./outboxService");
const { isOrchestrationEnabled } = require("../config/orchestration");
const { raiseException } = require("./exceptionCenterService");
const { hasLeadReplied } = require("./leadFollowUpSequenceService");

async function handleLeadNurtureExhausted(leadId) {
  const lead = await Lead.findById(leadId);
  if (!lead) return { skipped: true, reason: "lead_not_found" };

  if (lead.isConverted || lead.lifecycleState === "CONVERTED") {
    return { skipped: true, reason: "converted" };
  }

  if (lead.lifecycleState === "DORMANT" || lead.lifecycleState === "LOST") {
    return { skipped: true, reason: "already_dormant_or_lost" };
  }

  if (await hasLeadReplied(lead.correlationId)) {
    return { skipped: true, reason: "replied" };
  }

  lead.lifecycleState = "DORMANT";
  await lead.save();

  await raiseException({
    type: "lead_nurture_exhausted",
    correlationId: lead.correlationId,
    entityType: "Lead",
    entityId: lead._id,
    title: `No reply after nurture — ${lead.name}`,
    description: `Welcome + Day 3 + Day 7 emails sent with no response. Manual follow-up required.`,
    dedupeKey: `nurture_exhausted:${lead._id}`,
    payload: {
      leadId: lead._id.toString(),
      email: lead.email,
      assignedTo: lead.assignedTo?.toString?.() || lead.assignedTo,
    },
    sourceEventType: "lead.nurture_exhausted",
  });

  const assigneeId = lead.assignedTo || lead.whoassign;
  if (assigneeId) {
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 2);
    await FollowUpTask.create({
      title: `Call lead — no reply after nurture (${lead.name})`,
      description: "AI nurture sequence completed (Day 7). Lead marked DORMANT. Please call or email manually.",
      assignedTo: assigneeId,
      entityType: "lead",
      lead: lead._id,
      leadName: lead.name,
      leadStatus: lead.lifecycleState,
      taskType: "follow_up",
      dueDate,
      sourceKey: `nurture-exhausted:${lead._id}`,
      meta: { correlationId: lead.correlationId },
    }).catch(() => {});
  }

  if (isOrchestrationEnabled() && lead.correlationId) {
    await enqueueOutboxEvent({
      eventType: "lead.nurture_exhausted",
      aggregateType: "Lead",
      aggregateId: lead._id,
      correlationId: lead.correlationId,
      schemaVersion: 1,
      metadata: { actor: "system:nurture" },
      payload: {
        leadId: lead._id.toString(),
        correlationId: lead.correlationId,
        lifecycleState: "DORMANT",
      },
    });
  }

  await AgentLog.create({
    correlationId: lead.correlationId,
    eventType: "lead.nurture_exhausted",
    workerName: "follow-up-sequence",
    agentName: "FollowUpSchedulerAgent",
    message: `Lead marked DORMANT — nurture sequence exhausted for ${lead.name}`,
    result: "success",
  });

  return { dormant: true, leadId: lead._id.toString() };
}

module.exports = {
  handleLeadNurtureExhausted,
};
