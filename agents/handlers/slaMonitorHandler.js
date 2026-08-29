const Lead = require("../../models/Lead");
const User = require("../../models/User");
const AgentLog = require("../../models/AgentLog");
const { enqueueOutboxEvent } = require("../../services/outboxService");
const { isSlaBreached, getSlaHoursForPriority } = require("../../config/slaRules");
const { pauseAi } = require("../../services/aiPauseService");
const createNotification = require("../../utils/notification");
const { sendMailSafe, getEmailFrom } = require("../../utils/smtpTransporter");
const DomainEvent = require("../../models/DomainEvent");

const AGENT_NAME = "SlaMonitorAgent";

async function emitSlaBreachedIfNeeded(lead, context = {}) {
  if (!lead?.correlationId) return { skipped: true, reason: "no_correlation_id" };

  if (["CONTACTED", "CONVERTED", "LOST"].includes(lead.lifecycleState)) {
    return { skipped: true, reason: "already_contacted" };
  }

  if (!isSlaBreached(lead)) {
    return { skipped: true, reason: "within_sla" };
  }

  const alreadyEmitted = await DomainEvent.exists({
    correlationId: lead.correlationId,
    eventType: "sla.breached",
  });
  if (alreadyEmitted) {
    return { skipped: true, reason: "already_breached" };
  }

  const limitHours = context.slaHours || getSlaHoursForPriority(lead.priority);
  const eventId = context.eventId || `sla-${lead._id}-${Date.now()}`;

  await enqueueOutboxEvent({
    eventType: "sla.breached",
    aggregateType: "Lead",
    aggregateId: lead._id,
    correlationId: lead.correlationId,
    causationId: eventId,
    schemaVersion: 1,
    metadata: { actor: `agent:${AGENT_NAME}` },
    payload: {
      leadId: lead._id.toString(),
      correlationId: lead.correlationId,
      priority: lead.priority,
      slaHours: limitHours,
      message: `${lead.priority} lead exceeded ${limitHours}h first-contact SLA`,
    },
  });

  await AgentLog.create({
    correlationId: lead.correlationId,
    eventId,
    eventType: context.eventType || "sla.check",
    workerName: "sla",
    agentName: AGENT_NAME,
    message: `SLA breached — ${lead.priority} lead ${lead._id} (${limitHours}h)`,
    result: "success",
  });

  return { breached: true };
}

async function checkLeadContactSla(event) {
  const leadId = event.payload?.leadId || event.aggregateId;
  const lead = await Lead.findById(leadId).lean();
  if (!lead) return { skipped: true };
  return emitSlaBreachedIfNeeded(lead, {
    eventId: event.eventId,
    eventType: event.eventType,
  });
}

async function handleSlaBreached(event) {
  const leadId = event.payload?.leadId || event.aggregateId;
  const correlationId = event.correlationId || event.payload?.correlationId;
  const lead = await Lead.findById(leadId).lean();

  await pauseAi(correlationId, "waiting_human");

  const message =
    event.payload?.message ||
    `SLA breached for lead ${lead?.name || leadId} — AI paused pending manager review`;

  const managers = await User.find({
    role: { $in: ["Manager", "Super Admin"] },
    status: "Active",
  }).select("_id email name");

  for (const manager of managers) {
    await createNotification(
      "Lead",
      "SLA Breached",
      leadId,
      lead?.name || "Lead",
      manager._id,
      message
    );
  }

  const from = getEmailFrom();
  if (from && managers.length) {
    const html = `<p>${message}</p><p>AI automation is paused for this journey until a manager resumes it.</p>`;
    await Promise.allSettled(
      managers.map((m) =>
        sendMailSafe({
          from,
          to: m.email,
          subject: `[CRM SLA] First contact overdue — ${lead?.name || leadId}`,
          html,
        })
      )
    );
  }

  await AgentLog.create({
    correlationId,
    eventId: event.eventId,
    eventType: "sla.breached",
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    message: "Managers notified; AI paused for journey",
    result: "success",
  });

  return { handled: true, managersNotified: managers.length };
}

module.exports = {
  AGENT_NAME,
  emitSlaBreachedIfNeeded,
  checkLeadContactSla,
  handleSlaBreached,
};
