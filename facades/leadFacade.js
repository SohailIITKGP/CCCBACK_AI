const { randomUUID } = require("crypto");
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const User = require("../models/User");
const { writeWithOutboxEvent, enqueueOutboxEvent } = require("../services/outboxService");
const { cancelSequence } = require("../services/leadFollowUpSequenceService");
const { parseRequirementsFromEmail, extractLatestReplyBlock, repairRequirementsFromRemarks } = require("../services/emailRequirementParserService");
const { isOrchestrationEnabled } = require("../config/orchestration");
const { resumeAi } = require("../services/aiPauseService");
const { checkAndRaiseDuplicateOnCreate } = require("../services/leadDuplicateService");
const JourneyProcess = require("../models/JourneyProcess");

const TRACKED_UPDATE_FIELDS = new Set([
  "name",
  "contactNumber",
  "contactPerson",
  "email",
  "state",
  "designation",
  "sourceOfConnection",
  "priority",
  "remarks",
  "status",
  "assignedTo",
  "kindOfBusiness",
  "format",
  "clusters",
]);

const {
  sanitizeClusters,
  sanitizeFormat,
  sanitizeKindOfBusiness,
} = require("../constants/businessClassification");

function buildActorMeta(actor, ipAddress) {
  let actorLabel = "system";
  if (actor?.type === "user") actorLabel = "user";
  else if (actor?.type === "public") actorLabel = "public";

  return {
    actor: actorLabel,
    actorId: actor?.userId || null,
    ipAddress: ipAddress || null,
  };
}

function mergeClientFieldsFromLead(lead, clientFields = {}) {
  const merged = { ...(clientFields || {}) };

  if (!merged.kindOfBusiness && lead?.kindOfBusiness) {
    merged.kindOfBusiness = lead.kindOfBusiness;
  }
  if (!merged.format && lead?.format) {
    merged.format = lead.format;
  }
  if (
    (!Array.isArray(merged.clusters) || merged.clusters.length === 0) &&
    Array.isArray(lead?.clusters) &&
    lead.clusters.length > 0
  ) {
    merged.clusters = [...lead.clusters];
  }

  const hasRequirements =
    merged.city ||
    merged.preferredArea ||
    merged.minimumArea ||
    merged.expectedRent ||
    merged.kindOfBusiness;

  if (hasRequirements) return merged;

  return repairRequirementsFromRemarks(lead?.remarks, merged);
}

async function resumeAiAfterClientConversion(correlationId) {
  if (!correlationId) return;
  const proc = await JourneyProcess.findOne({ correlationId }).select("status pausedReason").lean();
  if (proc?.status !== "PAUSED") return;
  await resumeAi(correlationId);
}

async function runPostConvertOrchestration(correlationId) {
  if (!isOrchestrationEnabled() || !correlationId) return;
  await resumeAiAfterClientConversion(correlationId);
  try {
    const { drainOutbox, runInlineOrchestration } = require("../services/orchestrationTestHarness");
    await drainOutbox();
    await runInlineOrchestration(correlationId, 12);
  } catch (err) {
    console.error("[convertLeadToClient] post-convert orchestration failed:", err.message);
  }
}

async function createLead(leadData, actor = {}, options = {}) {
  const correlationId = leadData.correlationId || randomUUID();
  const payloadData = {
    ...leadData,
    kindOfBusiness: sanitizeKindOfBusiness(leadData.kindOfBusiness),
    format: sanitizeFormat(leadData.format),
    clusters: sanitizeClusters(leadData.clusters),
    correlationId,
    lifecycleState: leadData.lifecycleState || "NEW",
  };

  const { entity: lead } = await writeWithOutboxEvent(
    async (session) => {
      if (session) {
        const [doc] = await Lead.create([payloadData], { session });
        return doc;
      }
      return Lead.create(payloadData);
    },
    {
      eventType: "lead.created",
      aggregateType: "Lead",
      correlationId,
      schemaVersion: 1,
      metadata: buildActorMeta(actor, options.ipAddress),
      buildPayload: (leadDoc) => ({
        leadId: leadDoc._id.toString(),
        source: leadData.sourceOfConnection || "manual",
        correlationId: leadDoc.correlationId,
        name: leadDoc.name,
        priority: leadDoc.priority || null,
      }),
    }
  );

  checkAndRaiseDuplicateOnCreate(lead).catch((err) => {
    console.error("Duplicate lead check failed:", err);
  });

  return lead;
}

async function updateLead(leadId, updates, actor = {}, options = {}) {
  const existing = await Lead.findById(leadId);
  if (!existing) {
    return null;
  }

  const safeUpdates = { ...updates, updatedAt: new Date() };
  delete safeUpdates.correlationId;
  delete safeUpdates.lifecycleState;
  delete safeUpdates._id;
  delete safeUpdates.isConverted;
  delete safeUpdates.convertedTo;
  delete safeUpdates.convertedAt;
  delete safeUpdates.whoConverted;
  delete safeUpdates.createdBy;

  if (Object.prototype.hasOwnProperty.call(safeUpdates, "kindOfBusiness")) {
    safeUpdates.kindOfBusiness = sanitizeKindOfBusiness(safeUpdates.kindOfBusiness) || null;
  }
  if (Object.prototype.hasOwnProperty.call(safeUpdates, "format")) {
    safeUpdates.format = sanitizeFormat(safeUpdates.format) || null;
  }
  if (Object.prototype.hasOwnProperty.call(safeUpdates, "clusters")) {
    safeUpdates.clusters = sanitizeClusters(safeUpdates.clusters);
  }

  const changedFields = Object.keys(safeUpdates).filter((key) => {
    if (!TRACKED_UPDATE_FIELDS.has(key)) return false;
    if (key === "clusters") {
      return JSON.stringify(existing.clusters || []) !== JSON.stringify(safeUpdates.clusters || []);
    }
    return String(existing[key] ?? "") !== String(safeUpdates[key] ?? "");
  });

  const correlationId = existing.correlationId || randomUUID();
  if (!existing.correlationId) {
    safeUpdates.correlationId = correlationId;
  }

  const { entity: lead } = await writeWithOutboxEvent(
    async (session) => {
      const query = Lead.findByIdAndUpdate(leadId, safeUpdates, {
        new: true,
        runValidators: true,
      });
      if (session) query.session(session);
      return query;
    },
    {
      eventType: "lead.updated",
      aggregateType: "Lead",
      aggregateId: existing._id,
      correlationId,
      schemaVersion: 1,
      metadata: buildActorMeta(actor, options.ipAddress),
      buildPayload: (leadDoc) => ({
        leadId: leadDoc._id.toString(),
        correlationId: leadDoc.correlationId,
        changedFields,
      }),
    }
  );

  return lead;
}

async function convertLeadToClient(
  leadId,
  { priority, assignedTo, clientFields = {} },
  actor = {},
  options = {}
) {
  const lead = await Lead.findById(leadId);
  if (!lead) {
    return { error: "not_found" };
  }

  if (lead.isConverted) {
    return { error: "already_converted" };
  }

  const employee = await User.findById(assignedTo);
  if (!employee) {
    return { error: "invalid_employee" };
  }

  const correlationId = lead.correlationId || randomUUID();
  const actorUserId = actor.userId;
  const fields = mergeClientFieldsFromLead(lead, clientFields);
  const clusters = sanitizeClusters(fields.clusters);
  const format = sanitizeFormat(fields.format);
  const kindOfBusiness = sanitizeKindOfBusiness(fields.kindOfBusiness);

  const client = await Client.create({
    name: lead.name,
    contactDetails: lead.contactNumber,
    contactPerson: lead.contactPerson,
    email: lead.email,
    priority,
    remarks: lead.remarks,
    state: lead.state,
    isRead: lead.isRead,
    assignedTo,
    whoConverted: actorUserId,
    correlationId,
    city: fields.city || undefined,
    preferredArea: fields.preferredArea || undefined,
    otherPreferredAreas: fields.otherPreferredAreas || undefined,
    minimumArea: fields.minimumArea || undefined,
    expectedRent: fields.expectedRent || undefined,
    requirement: fields.requirement || undefined,
    kindOfBusiness: kindOfBusiness || undefined,
    format: format || undefined,
    clusters,
    specificRequirements: fields.specificRequirements || undefined,
  });

  employee.assignedClients.push(client._id);
  await employee.save();

  lead.isConverted = true;
  lead.convertedAt = new Date();
  lead.convertedTo = client._id;
  lead.whoConverted = actorUserId;
  lead.lifecycleState = "CONVERTED";
  if (!lead.correlationId) {
    lead.correlationId = correlationId;
  }
  await lead.save();

  await cancelSequence(lead._id, "converted");

  await enqueueOutboxEvent({
    eventType: "lead.converted",
    aggregateType: "Lead",
    aggregateId: lead._id,
    correlationId,
    schemaVersion: 1,
    metadata: buildActorMeta(actor, options.ipAddress),
    payload: {
      leadId: lead._id.toString(),
      clientId: client._id.toString(),
      correlationId,
    },
  });

  await enqueueOutboxEvent({
    eventType: "client.created",
    aggregateType: "Client",
    aggregateId: client._id,
    correlationId,
    schemaVersion: 1,
    metadata: buildActorMeta(actor, options.ipAddress),
    payload: {
      clientId: client._id.toString(),
      leadId: lead._id.toString(),
      correlationId,
      city: fields.city || null,
      hasRequirements: Boolean(fields.city || fields.preferredArea || fields.minimumArea),
    },
  });

  await runPostConvertOrchestration(correlationId);

  return { lead, client, correlationId, clientFields: fields };
}

module.exports = {
  createLead,
  updateLead,
  convertLeadToClient,
};
