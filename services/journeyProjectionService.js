const JourneyTimelineView = require("../models/JourneyTimelineView");
const JourneyProcess = require("../models/JourneyProcess");
const Lead = require("../models/Lead");
const Client = require("../models/Client");

const EVENT_SUMMARIES = {
  "lead.created": "Lead created",
  "lead.updated": "Lead updated",
  "lead.qualified": "Lead qualified by AI rules",
  "lead.converted": "Lead converted to client",
  "client.created": "Client record created",
  "client.requirements_updated": "Client requirements updated",
  "opportunity.created": "Opportunity opened",
  "opportunity.status_changed": "Opportunity status updated",
  "opportunity.site_visit_scheduled": "Site visit scheduled",
  "proposal.sent": "Proposal emailed to client",
  "proposal.viewed": "Client opened proposal link",
  "proposal.follow_up_sent": "Proposal follow-up sent (SLA)",
  "deal.site_visit_proposed": "AI proposed site visit",
  "property.matched": "AI property matches proposed",
  "properties.shared": "Property shortlist emailed to client",
  "property.linked": "Property linked to client",
  "property.override_linked": "Employee switched linked property",
  "property.unlinked": "Property unlinked from client",
  "proposal.superseded": "Proposal superseded — updated option sent",
  "exception.raised": "Exception raised for team review",
  "property.unavailable": "Property marked unavailable",
  "property.price_changed": "Property rent/price updated",
  "property.deleted": "Property deleted",
  "proposal.stale": "Proposal not opened (stale)",
  "lead.nurture_exhausted": "Lead nurture exhausted — marked DORMANT",
  "lead.merged": "Duplicate lead merged into primary record",
  "client.preference_learned": "Client preference learned for future matching",
  "employee.activity_logged": "Employee activity logged",
  "sla.breached": "First-contact SLA breached",
  "message.drafted": "Follow-up email drafted (pending approval)",
  "message.replied": "Client replied (inbound message)",
  "message.sent": "Follow-up email sent",
  "follow_up.scheduled": "Scheduled follow-up email drafted",
  "follow_up.cancelled": "Follow-up sequence cancelled",
  "agent.action_proposed": "AI action proposed",
  "agent.action_approved": "AI action approved",
  "agent.action_rejected": "AI action rejected",
};

function channelForEvent(eventType, metadata = {}) {
  if (eventType.startsWith("message.")) return "email";
  if (metadata?.actor?.startsWith("agent:")) return "ai";
  if (metadata?.actor === "user") return "manual";
  return "system";
}

async function upsertFromDomainEvent(event) {
  const {
    eventId,
    eventType,
    correlationId,
    aggregateId,
    payload = {},
    metadata = {},
  } = event;

  if (!correlationId) return;

  const summary =
    EVENT_SUMMARIES[eventType] ||
    eventType.replace(/\./g, " ");

  const entry = {
    eventId,
    eventType,
    summary,
    actor: metadata.actor || "system",
    channel: channelForEvent(eventType, metadata),
    timestamp: metadata.timestamp ? new Date(metadata.timestamp) : new Date(),
  };

  const update = {
    $setOnInsert: {
      correlationId,
      leadId: event.aggregateType === "Lead" ? aggregateId : payload.leadId,
    },
    $set: { lastEventAt: entry.timestamp },
    $push: { timeline: entry },
  };

  if (eventType === "lead.qualified") {
    update.$set.currentState = "QUALIFIED";
  }
  if (eventType === "message.sent") {
    update.$set.currentState = "CONTACTED";
  }
  if (eventType === "lead.converted") {
    update.$set.currentPhase = "MATCH";
    update.$set.currentState = "CONVERTED";
    if (payload.clientId) {
      update.$set.clientId = payload.clientId;
    }
  }
  if (eventType === "property.linked") {
    update.$set.currentPhase = "MATCH";
    update.$set.currentState = "PROPERTY_LINKED";
  }
  if (eventType === "opportunity.created" || eventType === "deal.site_visit_proposed") {
    update.$set.currentPhase = "DEAL";
    if (eventType === "opportunity.created") {
      update.$set.currentState = "OPPORTUNITY_OPEN";
    }
  }
  if (eventType === "opportunity.site_visit_scheduled") {
    update.$set.currentPhase = "DEAL";
    update.$set.currentState = "SITE_VISIT_SCHEDULED";
  }
  if (eventType === "proposal.sent") {
    update.$set.currentPhase = "DEAL";
    update.$set.currentState = "PROPOSAL_SENT";
  }
  if (eventType === "proposal.viewed") {
    update.$set.currentState = "PROPOSAL_VIEWED";
  }
  if (eventType === "proposal.superseded") {
    update.$set.currentState = "PROPOSAL_SUPERSEDED";
  }
  if (eventType === "property.override_linked") {
    update.$set.currentPhase = "MATCH";
    update.$set.currentState = "PROPERTY_OVERRIDE";
  }
  if (eventType === "proposal.follow_up_sent") {
    update.$set.currentState = "PROPOSAL_FOLLOWUP_SENT";
  }
  if (eventType === "agent.action_rejected") {
    update.$inc = { ...(update.$inc || {}), humanOverrideCount: 1 };
  } else if (eventType.startsWith("agent.action")) {
    update.$inc = { aiActionCount: 1 };
  }

  await JourneyTimelineView.updateOne({ correlationId }, update, { upsert: true });
}

async function getJourneyView(correlationId) {
  let view = await JourneyTimelineView.findOne({ correlationId }).lean();
  const process = await JourneyProcess.findOne({ correlationId }).lean();
  const lead = await Lead.findOne({ correlationId })
    .select("_id name email lifecycleState isConverted aiFollowUpState")
    .lean();
  const client = await Client.findOne({ correlationId })
    .select("_id name email")
    .lean();

  if (view) {
    return {
      ...view,
      process: process || null,
      lead: lead || null,
      client: client || null,
    };
  }

  if (!lead) return null;

  return {
    correlationId,
    leadId: lead._id,
    currentState: lead.lifecycleState,
    timeline: [],
    process: process || null,
    lead,
    client: client || null,
  };
}

module.exports = {
  upsertFromDomainEvent,
  getJourneyView,
};
