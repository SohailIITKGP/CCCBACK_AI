const Lead = require("../models/Lead");
const { getSlaQueue } = require("../queues/slaQueue");
const { getSlaHoursForPriority } = require("../config/slaRules");
const { emitSlaBreachedIfNeeded } = require("../agents/handlers/slaMonitorHandler");

function slaJobId(leadId) {
  return `sla-lead-${leadId}`;
}

async function scheduleLeadContactSlaCheck(lead) {
  if (!lead?._id || !lead.correlationId) return { skipped: true };

  const priority = lead.priority || "Medium";
  const hours = getSlaHoursForPriority(priority);
  const delayMs = hours * 3600 * 1000;

  const queue = getSlaQueue();
  const jobId = slaJobId(lead._id);

  try {
    const existing = await queue.getJob(jobId);
    if (existing) await existing.remove();
  } catch (_) {
    /* ignore */
  }

  await queue.add(
    "check-lead-contact",
    {
      leadId: lead._id.toString(),
      correlationId: lead.correlationId,
      priority,
      slaHours: hours,
    },
    { jobId, delay: delayMs }
  );

  return { scheduled: true, jobId, delayMs, slaHours: hours };
}

async function cancelLeadContactSlaCheck(leadId) {
  if (!leadId) return;
  const queue = getSlaQueue();
  const job = await queue.getJob(slaJobId(leadId));
  if (job) await job.remove();
}

async function runLeadContactSlaCheck({ leadId, correlationId, slaHours }) {
  const lead = await Lead.findById(leadId).lean();
  if (!lead) return { skipped: true, reason: "lead_not_found" };

  return emitSlaBreachedIfNeeded(lead, {
    eventId: `sla-job-${leadId}`,
    eventType: "sla.scheduled_check",
    slaHours,
    correlationId: correlationId || lead.correlationId,
  });
}

module.exports = {
  scheduleLeadContactSlaCheck,
  cancelLeadContactSlaCheck,
  runLeadContactSlaCheck,
  slaJobId,
};
