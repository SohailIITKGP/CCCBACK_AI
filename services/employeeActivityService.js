const Client = require("../models/Client");
const Lead = require("../models/Lead");
const EmployeeActivity = require("../models/EmployeeActivity");
const AgentLog = require("../models/AgentLog");
const {
  REQUIREMENT_FIELDS,
  emitRequirementsUpdated,
} = require("../facades/clientFacade");
const { enqueueOutboxEvent } = require("./outboxService");
const { isOrchestrationEnabled } = require("../config/orchestration");
const { logDataAction } = require("../utils/auditLogger");

function parseAmountToken(raw, unit) {
  const n = parseFloat(String(raw).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const u = String(unit || "").toLowerCase();
  if (u.startsWith("cr") || u === "crore") return n * 10000000;
  if (u.startsWith("l")) return n * 100000;
  if (n < 1000) return n * 100000;
  return n;
}

/**
 * Extract requirement hints from free-text activity notes.
 */
function parseRequirementsFromNote(note = "") {
  const text = String(note);
  const updates = {};

  const budgetPatterns = [
    /budget\s*(?:is|now|increased to|around|about)?\s*[₹]?\s*([\d,.]+)\s*(lakh|lac|cr|crore)?/i,
    /[₹]\s*([\d,]+(?:\.\d+)?)\s*(lakh|lac|cr|crore)?/i,
    /([\d,.]+)\s*(lakh|lac|cr|crore)\b/i,
  ];

  for (const pattern of budgetPatterns) {
    const match = text.match(pattern);
    if (match) {
      const amount = parseAmountToken(match[1], match[2]);
      if (amount) {
        updates.expectedRent = String(Math.round(amount));
        break;
      }
    }
  }

  const cityMatch = text.match(/\b(?:city|location|move(?:d)? to)\s*[:\-]?\s*([A-Za-z\s]{2,40})/i);
  if (cityMatch?.[1]) {
    updates.city = cityMatch[1].trim().split(/\s+/).slice(0, 3).join(" ");
  }

  const areaMatch = text.match(/\b(\d{2,6})\s*(?:sq\.?\s*ft|sqft|square feet)\b/i);
  if (areaMatch?.[1]) {
    updates.minimumArea = areaMatch[1];
  }

  const businessMatch = text.match(/\b(?:business|brand)\s*[:\-]?\s*([A-Za-z0-9\s&.-]{2,40})/i);
  if (businessMatch?.[1]) {
    updates.kindOfBusiness = businessMatch[1].trim();
  }

  return updates;
}

function mergeUpdates(parsed = {}, explicit = {}) {
  const merged = { ...parsed };
  for (const [key, value] of Object.entries(explicit || {})) {
    if (value != null && String(value).trim() !== "" && REQUIREMENT_FIELDS.has(key)) {
      merged[key] = String(value).trim();
    }
  }
  return merged;
}

async function applyClientRequirementUpdates(client, updates, actorUserId, ipAddress) {
  const before = client.toObject();
  let changed = false;

  for (const key of Object.keys(updates)) {
    if (!REQUIREMENT_FIELDS.has(key)) continue;
    if (String(before[key] ?? "") !== String(updates[key])) {
      client[key] = updates[key];
      changed = true;
    }
  }

  if (!changed) {
    return { changed: false, client };
  }

  if (!client.requirementsHistory) {
    client.requirementsHistory = [];
  }
  client.requirementsHistory = client.requirementsHistory || [];
  client.requirementsHistory.push({
    version: client.requirementsHistory.length + 1,
    at: new Date(),
    actorId: actorUserId,
    source: "employee_activity",
    snapshot: {
      city: client.city,
      preferredArea: client.preferredArea,
      expectedRent: client.expectedRent,
      minimumArea: client.minimumArea,
      requirement: client.requirement,
      kindOfBusiness: client.kindOfBusiness,
    },
  });

  await client.save();

  await emitRequirementsUpdated(client, { type: "user", userId: actorUserId }, { ipAddress });

  if (isOrchestrationEnabled() && client.correlationId) {
    await enqueueOutboxEvent({
      eventType: "employee.activity_logged",
      aggregateType: "Client",
      aggregateId: client._id,
      correlationId: client.correlationId,
      schemaVersion: 1,
      metadata: { actor: "user", actorId: actorUserId },
      payload: {
        clientId: client._id.toString(),
        correlationId: client.correlationId,
        updates,
        source: "employee_activity",
      },
    });
  }

  return { changed: true, client };
}

async function logEmployeeActivity({
  userId,
  clientId = null,
  leadId = null,
  channel = "phone",
  note,
  requirementUpdates = {},
  ipAddress = null,
  req = null,
}) {
  if (!userId || !note?.trim()) {
    return { error: "invalid_input", message: "userId and note are required" };
  }

  if (!clientId && !leadId) {
    return { error: "invalid_input", message: "clientId or leadId required" };
  }

  let client = null;
  let lead = null;
  let correlationId = null;

  if (clientId) {
    client = await Client.findById(clientId);
    if (!client) return { error: "not_found", message: "Client not found" };
    correlationId = client.correlationId;
  }

  if (leadId) {
    lead = await Lead.findById(leadId);
    if (!lead) return { error: "not_found", message: "Lead not found" };
    correlationId = correlationId || lead.correlationId;
  }

  const parsedUpdates = parseRequirementsFromNote(note);
  const mergedUpdates = mergeUpdates(parsedUpdates, requirementUpdates);

  let requirementsChanged = false;
  if (client && Object.keys(mergedUpdates).length) {
    const applyResult = await applyClientRequirementUpdates(
      client,
      mergedUpdates,
      userId,
      ipAddress
    );
    requirementsChanged = applyResult.changed;
    client = applyResult.client;
  }

  const activity = await EmployeeActivity.create({
    userId,
    clientId: client?._id || null,
    leadId: lead?._id || null,
    correlationId,
    channel,
    note: note.trim(),
    parsedUpdates,
    appliedUpdates: requirementsChanged ? mergedUpdates : {},
    requirementsChanged,
  });

  if (lead && !lead.isConverted) {
    lead.lifecycleState = lead.lifecycleState === "NEW" ? "ENGAGED" : lead.lifecycleState;
    if (lead.remarks) {
      lead.remarks = `${lead.remarks}\n[${channel}] ${note.trim()}`.slice(0, 4000);
    } else {
      lead.remarks = `[${channel}] ${note.trim()}`.slice(0, 4000);
    }
    await lead.save();

    if (isOrchestrationEnabled() && lead.correlationId) {
      await enqueueOutboxEvent({
        eventType: "employee.activity_logged",
        aggregateType: "Lead",
        aggregateId: lead._id,
        correlationId: lead.correlationId,
        schemaVersion: 1,
        metadata: { actor: "user", actorId: userId },
        payload: {
          leadId: lead._id.toString(),
          correlationId: lead.correlationId,
          channel,
          note: note.trim().slice(0, 300),
        },
      });
    }
  }

  if (correlationId) {
    await AgentLog.create({
      correlationId,
      eventType: "employee.activity_logged",
      workerName: "activity",
      agentName: "EmployeeActivityAgent",
      message: requirementsChanged
        ? `Activity logged — requirements updated from ${channel} note`
        : `Activity logged (${channel})`,
      result: "success",
      meta: {
        activityId: activity._id.toString(),
        requirementsChanged,
        parsedUpdates,
      },
    });
  }

  if (req) {
    logDataAction(req, {
      action: "data_update",
      resource: client ? "Client" : "Lead",
      resourceId: client?._id || lead?._id,
      entityName: client?.name || lead?.name || "Entity",
      details: {
        action: "employee_activity_logged",
        channel,
        requirementsChanged,
        activityId: activity._id.toString(),
      },
    }).catch(() => {});
  }

  if (clientId) {
    const { recordFromActivityNote } = require("./clientPreferenceMemoryService");
    await recordFromActivityNote({
      clientId,
      correlationId,
      note,
      userId,
    }).catch((err) =>
      console.error("[employeeActivity] preference memory failed:", err.message)
    );
  }

  return {
    success: true,
    activity,
    requirementsChanged,
    parsedUpdates,
    appliedUpdates: requirementsChanged ? mergedUpdates : {},
  };
}

async function listActivitiesForClient(clientId, limit = 30) {
  return EmployeeActivity.find({ clientId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("userId", "name role")
    .lean();
}

async function listActivitiesForLead(leadId, limit = 30) {
  return EmployeeActivity.find({ leadId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("userId", "name role")
    .lean();
}

module.exports = {
  logEmployeeActivity,
  parseRequirementsFromNote,
  listActivitiesForClient,
  listActivitiesForLead,
};
