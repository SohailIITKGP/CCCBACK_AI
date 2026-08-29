const Opportunity = require("../models/Opportunity");
const { buildReminderStateForStatus } = require("./opportunityReminderService");
const { createScheduledTask, regenerateReminderScheduleTasks } = require("./followUpTaskService");
const { isReminderTrackedStatus } = require("./opportunityReminderService");

/**
 * Add opportunity comment + optional site visit / follow-up tasks.
 * Mirrors POST /opportunity/:id/comment behaviour for agent-approved actions.
 */
async function addCommentWithTasks({
  opportunityId,
  userId,
  tag,
  comment,
  sitevisit = null,
  followup = null,
}) {
  const opportunity = await Opportunity.findById(opportunityId)
    .populate("client", "name email phone correlationId")
    .populate("property", "name address");

  if (!opportunity) {
    return { error: "not_found" };
  }

  const newComment = {
    tag,
    comment: comment || "",
    sitevisit: sitevisit || { date: null, notification: false },
    followup: followup || { date: null, notification: false },
    whoCommented: userId,
  };

  opportunity.commentsSection.push(newComment);
  const previousStatus = opportunity.status;
  opportunity.status = tag;

  if (previousStatus !== tag || !opportunity.reminderState || opportunity.reminderState.status !== tag) {
    opportunity.reminderState = buildReminderStateForStatus(tag);
  }

  await opportunity.save();
  const savedComment = opportunity.commentsSection[opportunity.commentsSection.length - 1];

  if (isReminderTrackedStatus(tag)) {
    regenerateReminderScheduleTasks(opportunity).catch((err) =>
      console.error("[opportunityCommentService] reminder schedule failed:", err.message)
    );
  }

  const tasksCreated = [];
  if (followup?.date) {
    const t = await createScheduledTask({
      opportunity,
      commentId: savedComment._id,
      taskType: "follow_up",
      dueDate: followup.date,
      assignedTo: userId,
    });
    if (t?.task) tasksCreated.push(t.task._id);
  }
  if (sitevisit?.date) {
    const t = await createScheduledTask({
      opportunity,
      commentId: savedComment._id,
      taskType: "site_visit",
      dueDate: sitevisit.date,
      assignedTo: userId,
    });
    if (t?.task) tasksCreated.push(t.task._id);
  }

  return {
    opportunity,
    comment: savedComment,
    tasksCreated,
    correlationId: opportunity.client?.correlationId,
  };
}

module.exports = {
  addCommentWithTasks,
};
