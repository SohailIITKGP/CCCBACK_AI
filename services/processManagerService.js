const JourneyProcess = require("../models/JourneyProcess");

async function createProcessForLead(lead) {
  const doc = await JourneyProcess.findOneAndUpdate(
    { correlationId: lead.correlationId },
    {
      $setOnInsert: {
        correlationId: lead.correlationId,
        processType: "LEAD_TO_CLOSE",
        currentPhase: "ACQUIRE",
        currentStep: "lead_created",
        status: "ACTIVE",
        context: {
          leadId: lead._id,
          lastSuccessfulStep: "lead_created",
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return doc;
}

async function onLeadQualified(correlationId) {
  await JourneyProcess.findOneAndUpdate(
    { correlationId },
    {
      currentPhase: "NURTURE",
      currentStep: "awaiting_first_contact",
      "context.lastSuccessfulStep": "lead_qualified",
    }
  );
}

async function onMessageSent(correlationId) {
  await JourneyProcess.findOneAndUpdate(
    { correlationId },
    {
      currentStep: "first_contact_sent",
      "context.lastSuccessfulStep": "message_sent",
    }
  );
}

async function onLeadConverted(correlationId, clientId) {
  await JourneyProcess.findOneAndUpdate(
    { correlationId },
    {
      currentPhase: "MATCH",
      currentStep: "client_created",
      "context.clientId": clientId,
      "context.lastSuccessfulStep": "lead_converted",
    }
  );
}

async function onPropertyLinked(correlationId) {
  await JourneyProcess.findOneAndUpdate(
    { correlationId },
    {
      currentPhase: "MATCH",
      currentStep: "property_linked",
      "context.lastSuccessfulStep": "property_linked",
    }
  );
}

async function onOpportunityCreated(correlationId, opportunityId) {
  await JourneyProcess.findOneAndUpdate(
    { correlationId },
    {
      currentPhase: "DEAL",
      currentStep: "opportunity_open",
      $addToSet: { "context.opportunityIds": opportunityId },
      "context.lastSuccessfulStep": "opportunity_created",
    }
  );
}

async function onDealSiteVisitScheduled(correlationId) {
  await JourneyProcess.findOneAndUpdate(
    { correlationId },
    {
      currentPhase: "DEAL",
      currentStep: "site_visit_scheduled",
      "context.lastSuccessfulStep": "site_visit_scheduled",
    }
  );
}

async function onOpportunityClosed(correlationId, outcome) {
  await JourneyProcess.findOneAndUpdate(
    { correlationId },
    {
      currentPhase: "CLOSE",
      currentStep: outcome === "won" ? "deal_won" : "deal_lost",
      status: "COMPLETED",
      completedAt: new Date(),
      "context.lastSuccessfulStep": outcome === "won" ? "opportunity_won" : "opportunity_lost",
    }
  );
}

module.exports = {
  createProcessForLead,
  onLeadQualified,
  onMessageSent,
  onLeadConverted,
  onPropertyLinked,
  onOpportunityCreated,
  onDealSiteVisitScheduled,
  onOpportunityClosed,
};
