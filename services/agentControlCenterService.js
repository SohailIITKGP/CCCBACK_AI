const AgentAction = require("../models/AgentAction");
const AgentLog = require("../models/AgentLog");
const JourneyProcess = require("../models/JourneyProcess");
const Lead = require("../models/Lead");
const Property = require("../models/propertyModel");
const RuleChangeProposal = require("../models/RuleChangeProposal");
const OutboxEvent = require("../models/OutboxEvent");
const { isOrchestrationEnabled } = require("../config/orchestration");
const { getAutomationSettings } = require("./agentAutomationService");

const AGENT_CATALOG = [
  {
    name: "LeadQualificationAgent",
    trigger: "New lead created",
    effect: "Scores priority and marks lead QUALIFIED",
    needsApproval: false,
  },
  {
    name: "LeadConversionAgent",
    trigger: "Client replies by email with full requirements",
    effect: "Converts lead to client with city/area/rent from email",
    needsApproval: true,
    intent: "propose_lead_conversion",
  },
  {
    name: "FollowUpSchedulerAgent",
    trigger: "Lead qualified",
    effect: "Drafts welcome/follow-up email",
    needsApproval: true,
    intent: "send_email",
  },
  {
    name: "PropertyMatchingAgent",
    trigger: "Client created or requirements updated",
    effect: "Suggests top 3 properties",
    needsApproval: true,
    intent: "suggest_properties",
  },
  {
    name: "DealOrchestratorAgent",
    trigger: "Opportunity created",
    effect: "Proposes site visit",
    needsApproval: true,
    intent: "propose_site_visit",
  },
  {
    name: "SlaMonitorAgent",
    trigger: "First-contact SLA overdue",
    effect: "Notifies managers and pauses AI on journey",
    needsApproval: false,
  },
  {
    name: "ResponseAgent",
    trigger: "Client reply (email webhook)",
    effect: "Parses reply and triggers lead conversion when requirements are complete",
    needsApproval: false,
  },
];

const AI_DOES = [
  "Qualify new leads using rules",
  "Draft emails for your approval",
  "Parse inbound email replies for city, area, size, and budget",
  "Auto-reply when details are missing; confirm when requirements are complete",
  "Propose or auto-convert lead → client when requirements are complete",
  "Suggest property matches for your approval",
  "Propose site visits for your approval",
  "Track journey phases (Acquire → Nurture → Match → Deal → Close)",
  "Pause automation when SLA is breached",
];

const AI_DOES_NOT = [
  "Change opportunity to Win/Loss automatically",
  "Approve site visits without you (always manual)",
  "Replace Tasks page reminders (those stay human-managed)",
  "Run at all if the background worker is stopped",
];

async function getControlCenterSummary() {
  const [
    pendingActions,
    pausedProcesses,
    recentLogs,
    pendingProperties,
    pendingProposals,
    failedOutbox,
  ] = await Promise.all([
    AgentAction.find({ status: "pending_approval" }).sort({ createdAt: -1 }).limit(50).lean(),
    JourneyProcess.find({ status: "PAUSED" }).sort({ updatedAt: -1 }).limit(20).lean(),
    AgentLog.find({}).sort({ createdAt: -1 }).limit(30).lean(),
    Property.countDocuments({ propertyStatus: "draft" }),
    RuleChangeProposal.countDocuments({ status: "pending" }),
    OutboxEvent.countDocuments({ status: "failed" }),
  ]);

  const correlationIds = pausedProcesses.map((p) => p.correlationId);
  const leads = await Lead.find({ correlationId: { $in: correlationIds } })
    .select("name correlationId email")
    .lean();
  const leadByCorrelation = Object.fromEntries(leads.map((l) => [l.correlationId, l]));

  const pausedJourneys = pausedProcesses.map((p) => ({
    correlationId: p.correlationId,
    phase: p.currentPhase,
    step: p.currentStep,
    pausedReason: p.pausedReason,
    updatedAt: p.updatedAt,
    leadName: leadByCorrelation[p.correlationId]?.name || "Unknown lead",
  }));

  const automation = await getAutomationSettings();

  return {
    system: {
      orchestrationEnabled: isOrchestrationEnabled(),
      redisConfigured: Boolean(process.env.REDIS_URL),
      workerRequired: true,
      workerCommand: "cd cccback && npm run worker",
    },
    counts: {
      pendingApprovals: pendingActions.length,
      pausedJourneys: pausedJourneys.length,
      pendingPropertySubmissions: pendingProperties,
      pendingRuleProposals: pendingProposals,
      failedOutboxEvents: failedOutbox,
    },
    catalog: AGENT_CATALOG,
    aiDoes: AI_DOES,
    aiDoesNot: AI_DOES_NOT,
    pendingActions,
    pausedJourneys,
    recentLogs,
    automation,
  };
}

module.exports = {
  AGENT_CATALOG,
  getControlCenterSummary,
};
