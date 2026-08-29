const AgentAction = require("../models/AgentAction");
const AgentLog = require("../models/AgentLog");
const FollowUpTask = require("../models/FollowUpTask");
const agentActionService = require("./agentActionService");
const { addCommentWithTasks } = require("./opportunityCommentService");
const { enqueueOutboxEvent } = require("./outboxService");
const processManagerService = require("./processManagerService");
const { isHumanOnlyStatus } = require("../config/opportunityStateMachine");
const { pauseAi } = require("./aiPauseService");

async function executeApprovedDealAction(action, userId) {
  if (action.status !== "pending_approval") {
    return { error: "invalid_status" };
  }

  if (action.intent === "propose_site_visit") {
    return executeSiteVisitProposal(action, userId);
  }

  if (action.intent === "propose_status_change") {
    const toStatus = action.payload?.proposedStatus;
    if (isHumanOnlyStatus(toStatus)) {
      return { error: "human_only_status", message: "Win/Loss/Reject require direct manager action" };
    }
    return executeSiteVisitProposal(
      {
        ...action.toObject?.() || action,
        payload: {
          ...action.payload,
          proposedStatus: toStatus,
          siteVisitDate: action.payload?.siteVisitDate || null,
        },
      },
      userId
    );
  }

  return { error: "unsupported_intent" };
}

async function executeSiteVisitProposal(action, userId) {
  const {
    opportunityId,
    proposedStatus,
    siteVisitDate,
    comment,
  } = action.payload || {};

  if (!opportunityId || !proposedStatus) {
    await agentActionService.markFailed(action._id, "Missing opportunity or status");
    return { error: "invalid_payload" };
  }

  const sitevisit = siteVisitDate
    ? { date: new Date(siteVisitDate), notification: true }
    : null;

  const result = await addCommentWithTasks({
    opportunityId,
    userId,
    tag: proposedStatus,
    comment: comment || `Approved AI proposal: ${proposedStatus}`,
    sitevisit,
  });

  if (result.error) {
    await agentActionService.markFailed(action._id, result.error);
    return { error: result.error };
  }

  await agentActionService.markExecuted(action._id, {
    opportunityId,
    proposedStatus,
    siteVisitDate,
    tasksCreated: result.tasksCreated?.length || 0,
    approvedBy: userId?.toString(),
  });

  await AgentAction.findByIdAndUpdate(action._id, { approvedBy: userId });

  const correlationId = result.correlationId || action.correlationId;
  if (correlationId) {
    await processManagerService.onDealSiteVisitScheduled(correlationId);
    await pauseAi(correlationId, "site_visit_scheduled_manual_mode");

    await enqueueOutboxEvent({
      eventType: "opportunity.status_changed",
      aggregateType: "Opportunity",
      aggregateId: opportunityId,
      correlationId,
      schemaVersion: 1,
      metadata: { actor: "user", actorId: userId },
      payload: {
        opportunityId,
        to: proposedStatus,
        correlationId,
      },
    });

    if (siteVisitDate) {
      await enqueueOutboxEvent({
        eventType: "opportunity.site_visit_scheduled",
        aggregateType: "Opportunity",
        aggregateId: opportunityId,
        correlationId,
        schemaVersion: 1,
        metadata: { actor: "user", actorId: userId },
        payload: {
          opportunityId,
          siteVisitDate,
          correlationId,
        },
      });
    }
  }

  await AgentLog.create({
    correlationId: action.correlationId,
    workerName: "deal_orchestrator",
    agentName: "DealOrchestratorAgent",
    message: `Site visit approved for opportunity ${opportunityId}`,
    result: "success",
  });

  const taskCount = await FollowUpTask.countDocuments({
    opportunity: opportunityId,
    taskType: "site_visit",
    status: "Pending",
  });

  return {
    executed: true,
    opportunityId,
    status: proposedStatus,
    siteVisitTasks: taskCount,
  };
}

module.exports = {
  executeApprovedDealAction,
};
