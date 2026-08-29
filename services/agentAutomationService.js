const Lead = require("../models/Lead");
const User = require("../models/User");
const RuleConfig = require("../models/RuleConfig");
const AgentLog = require("../models/AgentLog");

const CONFIG_KEY = "agent.automation";

const DEFAULT_AUTOMATION = {
  autoWelcomeEmail: false,
  autoLinkHighScore: false,
  autoLinkMinScore: 85,
  autoConvertFromEmail: false,
  autoSharePropertiesEmail: false,
  autoSendProposalEmail: false,
  minPropertyShareScore: 60,
};

let settingsCache = null;
let settingsCacheAt = 0;
let automationActorId = null;

const CACHE_TTL_MS = 30_000;

function mergeSettings(value) {
  return {
    ...DEFAULT_AUTOMATION,
    ...(value || {}),
    autoLinkMinScore: Math.max(
      50,
      Math.min(100, Number(value?.autoLinkMinScore ?? DEFAULT_AUTOMATION.autoLinkMinScore))
    ),
    minPropertyShareScore: Math.max(
      20,
      Math.min(100, Number(value?.minPropertyShareScore ?? DEFAULT_AUTOMATION.minPropertyShareScore))
    ),
  };
}

async function getAutomationSettings(force = false) {
  if (!force && settingsCache && Date.now() - settingsCacheAt < CACHE_TTL_MS) {
    return { ...settingsCache };
  }
  const row = await RuleConfig.findOne({ configKey: CONFIG_KEY }).lean();
  settingsCache = mergeSettings(row?.value);
  settingsCacheAt = Date.now();
  return { ...settingsCache };
}

async function updateAutomationSettings(value, userId) {
  const merged = mergeSettings(value);
  await RuleConfig.findOneAndUpdate(
    { configKey: CONFIG_KEY },
    {
      configKey: CONFIG_KEY,
      value: merged,
      updatedBy: userId || null,
    },
    { upsert: true, new: true }
  );
  settingsCache = merged;
  settingsCacheAt = Date.now();
  return merged;
}

async function getAutomationActorId() {
  if (automationActorId) return automationActorId;
  const actor =
    (await User.findOne({ role: "Super Admin", status: "Active" }).select("_id").lean()) ||
    (await User.findOne({ role: "Manager", status: "Active" }).select("_id").lean());
  automationActorId = actor?._id || null;
  return automationActorId;
}

function shouldAutoExecute(action, settings) {
  if (!action || action.status !== "pending_approval") return false;

  if (action.intent === "send_email") {
    const templateId = action.payload?.templateId;
    if (templateId === "client_properties_share_v1") {
      if (!settings.autoSharePropertiesEmail) return false;
      const topScore = action.payload?.topScore;
      if (typeof topScore === "number" && topScore < settings.minPropertyShareScore) {
        return false;
      }
      return true;
    }
    if (settings.autoWelcomeEmail) {
      return true;
    }
  }

  if (action.intent === "suggest_properties" && settings.autoLinkHighScore) {
    const top = action.payload?.suggestions?.[0];
    const score = top?.score;
    if (typeof score !== "number") return false;
    return score >= settings.autoLinkMinScore;
  }

  if (action.intent === "propose_lead_conversion" && settings.autoConvertFromEmail) {
    return true;
  }

  return false;
}

async function tryAutoExecute(action) {
  const settings = await getAutomationSettings();
  if (!shouldAutoExecute(action, settings)) {
    return { skipped: true, reason: "automation_off_or_below_threshold" };
  }

  const actorId = await getAutomationActorId();
  if (!actorId) {
    return { skipped: true, reason: "no_automation_actor" };
  }

  const fresh = await require("../models/AgentAction").findById(action._id);
  if (!fresh || fresh.status !== "pending_approval") {
    return { skipped: true, reason: "not_pending" };
  }

  const agentActionExecutionService = require("./agentActionExecutionService");
  const exec = await agentActionExecutionService.executeAction(fresh, actorId, {
    source: "automation",
  });

  if (exec.error) {
    await AgentLog.create({
      correlationId: fresh.correlationId,
      eventId: fresh.triggerEventId,
      eventType: "agent.automation",
      workerName: "orchestrator",
      agentName: fresh.agentName,
      message: `Auto-execute failed: ${exec.error}`,
      result: "failed",
      meta: { agentActionId: fresh._id.toString(), reason: exec.reason || exec.message },
    });
    return { executed: false, error: exec.error };
  }

  await AgentLog.create({
    correlationId: fresh.correlationId,
    eventId: fresh.triggerEventId,
    eventType: "agent.automation",
    workerName: "orchestrator",
    agentName: fresh.agentName,
    message: `Auto-executed ${fresh.intent} (automation mode)`,
    result: "success",
    meta: { agentActionId: fresh._id.toString(), intent: fresh.intent },
  });

  return { executed: true, intent: fresh.intent, result: exec };
}

module.exports = {
  CONFIG_KEY,
  DEFAULT_AUTOMATION,
  getAutomationSettings,
  updateAutomationSettings,
  shouldAutoExecute,
  tryAutoExecute,
  getAutomationActorId,
};
