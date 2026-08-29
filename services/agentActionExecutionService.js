const AgentAction = require("../models/AgentAction");
const communicationAgentService = require("./communicationAgentService");
const propertyMatchingExecutionService = require("./propertyMatchingExecutionService");
const dealExecutionService = require("./dealExecutionService");
const leadEmailConversionService = require("./leadEmailConversionService");

/** Intents safe for batch / automation (site visit always needs human). */
const BATCH_APPROVE_INTENTS = [
  "send_email",
  "suggest_properties",
  "propose_lead_conversion",
];

async function executeAction(action, userId, options = {}) {
  const doc =
    action?.status != null
      ? action
      : await AgentAction.findById(action._id || action);

  if (!doc) return { error: "not_found" };
  if (doc.status !== "pending_approval") {
    return { error: "invalid_status", status: doc.status };
  }

  let exec;
  if (doc.intent === "send_email") {
    exec = await communicationAgentService.executeApprovedAction(doc, userId);
  } else if (doc.intent === "suggest_properties") {
    exec = await propertyMatchingExecutionService.executeApprovedSuggestion(doc, userId);
  } else if (doc.intent === "propose_lead_conversion") {
    exec = await leadEmailConversionService.executeProposedConversion(doc, userId);
  } else if (doc.intent === "propose_site_visit" || doc.intent === "propose_status_change") {
    exec = await dealExecutionService.executeApprovedDealAction(doc, userId);
  } else {
    return { error: "unsupported_intent", intent: doc.intent };
  }

  if (exec.error) {
    return exec;
  }

  return { ...exec, actionId: doc._id.toString(), source: options.source || "manual" };
}

async function batchApproveActions(userId, { intents = BATCH_APPROVE_INTENTS } = {}) {
  const pending = await AgentAction.find({
    status: "pending_approval",
    intent: { $in: intents },
  })
    .sort({ createdAt: 1 })
    .limit(50);

  const summary = {
    total: pending.length,
    approved: 0,
    failed: 0,
    errors: [],
  };

  for (const action of pending) {
    const exec = await executeAction(action, userId, { source: "batch" });
    if (exec.error) {
      summary.failed += 1;
      summary.errors.push({
        actionId: action._id.toString(),
        intent: action.intent,
        error: exec.error,
        reason: exec.reason || exec.message,
      });
    } else {
      summary.approved += 1;
    }
  }

  return summary;
}

module.exports = {
  BATCH_APPROVE_INTENTS,
  executeAction,
  batchApproveActions,
};
