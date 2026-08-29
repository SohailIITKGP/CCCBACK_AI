const Lead = require("../../models/Lead");
const AgentLog = require("../../models/AgentLog");
const DomainEvent = require("../../models/DomainEvent");
const { getGeminiModelName } = require("../../config/gemini");
const { computeLeadPriority, shouldQualifyLead } = require("../../config/decisionRules");
const { enqueueOutboxEvent } = require("../../services/outboxService");
const processManagerService = require("../../services/processManagerService");
const { isAiPaused } = require("../../services/aiPauseService");
const ruleConfigService = require("../../services/ruleConfigService");

const AGENT_NAME = "LeadQualificationAgent";
const AGENT_VERSION = "1.0.0";

async function extractRequirementsHint(lead) {
  if (!process.env.GEMINI_API_KEY) return null;
  if (String(process.env.LEAD_QUALIFICATION_USE_GEMINI || "").toLowerCase() === "false") {
    return null;
  }
  try {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: getGeminiModelName(),
      generationConfig: { responseMimeType: "application/json" },
    });
    const prompt = `Extract commercial property requirements from this lead. Return JSON only:
{"city":"","preferredArea":"","businessType":"","summary":""}
Lead name: ${lead.name}
Remarks: ${lead.remarks || ""}
State: ${lead.state || ""}`;
    const result = await model.generateContent(prompt);
    const text = result.response.text().replace(/```json|```/g, "").trim();
    return JSON.parse(text);
  } catch (err) {
    console.warn("[LeadQualificationAgent] Gemini skip:", err.message);
    return null;
  }
}

async function handleLeadCreated(event) {
  const leadId = event.aggregateId || event.payload?.leadId;
  const lead = await Lead.findById(leadId);
  if (!lead || !lead.correlationId) return { skipped: true };

  if (await isAiPaused(lead.correlationId)) {
    return { skipped: true, reason: "ai_paused" };
  }

  await processManagerService.createProcessForLead(lead);

  if (lead.lifecycleState === "QUALIFIED" || lead.lifecycleState === "CONVERTED") {
    return { skipped: true, reason: "already_qualified" };
  }

  const alreadyQualified = await DomainEvent.exists({
    correlationId: lead.correlationId,
    eventType: "lead.qualified",
  });
  if (alreadyQualified) {
    return { skipped: true, reason: "lead_qualified_event_exists" };
  }

  if (!shouldQualifyLead(lead)) {
    return { skipped: true, reason: "not_eligible" };
  }

  const scoringBonuses = await ruleConfigService.getLeadScoringBonuses();
  const { priority, score, reasoning } = computeLeadPriority(lead, scoringBonuses);
  const aiHint = await extractRequirementsHint(lead);

  lead.priority = priority;
  lead.lifecycleState = "QUALIFIED";
  if (aiHint?.summary) {
    lead.remarks = lead.remarks
      ? `${lead.remarks}\n[AI] ${aiHint.summary}`.slice(0, 2000)
      : `[AI] ${aiHint.summary}`;
  }
  await lead.save();

  await enqueueOutboxEvent({
    eventType: "lead.qualified",
    aggregateType: "Lead",
    aggregateId: lead._id,
    correlationId: lead.correlationId,
    causationId: event.eventId,
    schemaVersion: 1,
    metadata: { actor: `agent:${AGENT_NAME}` },
    payload: {
      leadId: lead._id.toString(),
      correlationId: lead.correlationId,
      priority,
      score,
      reasoning,
    },
  });

  await AgentLog.create({
    correlationId: lead.correlationId,
    eventId: event.eventId,
    eventType: event.eventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
    message: `Lead qualified with priority ${priority} (score ${score})`,
    result: "success",
    meta: { priority, score },
  });

  return { qualified: true, priority };
}

module.exports = {
  AGENT_NAME,
  handleLeadCreated,
};
