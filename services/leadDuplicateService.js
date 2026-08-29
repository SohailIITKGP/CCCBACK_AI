const Lead = require("../models/Lead");
const { cancelSequence } = require("./leadFollowUpSequenceService");
const { enqueueOutboxEvent } = require("./outboxService");
const { isOrchestrationEnabled } = require("../config/orchestration");
const { raiseException } = require("./exceptionCenterService");
const { logAutomationEvent } = require("../utils/auditLogger");

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePhone(value) {
  if (!value) return "";
  const digits = String(value).replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

function buildMatchReason(lead, candidate) {
  const reasons = [];
  if (
    lead.email &&
    candidate.email &&
    lead.email.toLowerCase() === candidate.email.toLowerCase()
  ) {
    reasons.push("email");
  }
  const a = normalizePhone(lead.contactNumber);
  const b = normalizePhone(candidate.contactNumber);
  if (a && b && a === b) {
    reasons.push("phone");
  }
  return reasons.join("+") || "similar";
}

async function findDuplicateCandidates(lead) {
  if (!lead) return [];

  const or = [];
  if (lead.email) {
    or.push({ email: new RegExp(`^${escapeRegex(lead.email.trim())}$`, "i") });
  }
  const phone = normalizePhone(lead.contactNumber);
  if (phone.length >= 10) {
    or.push({ contactNumber: new RegExp(`${phone}$`) });
  }

  if (!or.length) return [];

  const rows = await Lead.find({
    _id: { $ne: lead._id },
    isConverted: { $ne: true },
    mergedIntoLead: null,
    lifecycleState: { $nin: ["LOST", "CONVERTED"] },
    $or: or,
  })
    .select("name email contactNumber sourceOfConnection createdAt lifecycleState correlationId")
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  return rows.map((row) => ({
    ...row,
    matchReason: buildMatchReason(lead, row),
  }));
}

async function checkAndRaiseDuplicateOnCreate(lead) {
  const duplicates = await findDuplicateCandidates(lead);
  if (!duplicates.length) return { duplicates: [] };

  const top = duplicates[0];
  await raiseException({
    type: "duplicate_lead",
    correlationId: lead.correlationId,
    entityType: "Lead",
    entityId: lead._id,
    title: `Possible duplicate lead — ${lead.name}`,
    description: `Matches existing lead "${top.name}" (${top.matchReason}). Review and merge if same person.`,
    dedupeKey: `dup_lead:${lead._id}:${top._id}`,
    payload: {
      leadId: lead._id.toString(),
      duplicateOfLeadId: top._id.toString(),
      matchReason: top.matchReason,
    },
    sourceEventType: "lead.created",
  });

  return { duplicates, exceptionRaised: true };
}

async function mergeLeads({ primaryLeadId, duplicateLeadId, userId, reason = "same_person" }) {
  if (String(primaryLeadId) === String(duplicateLeadId)) {
    return { error: "same_lead", message: "Cannot merge a lead into itself" };
  }

  const [primary, duplicate] = await Promise.all([
    Lead.findById(primaryLeadId),
    Lead.findById(duplicateLeadId),
  ]);

  if (!primary || !duplicate) {
    return { error: "not_found", message: "Lead not found" };
  }

  if (primary.isConverted || duplicate.isConverted) {
    return { error: "converted", message: "Cannot merge converted leads" };
  }

  if (duplicate.mergedIntoLead) {
    return { error: "already_merged", message: "Duplicate lead was already merged" };
  }

  const dupNote = `[Merged duplicate ${duplicate.name} — ${reason}] ${duplicate.remarks || ""}`.trim();
  if (dupNote && !String(primary.remarks || "").includes(dupNote.slice(0, 40))) {
    primary.remarks = primary.remarks ? `${primary.remarks}\n\n${dupNote}` : dupNote;
  }

  if (!primary.assignedTo && duplicate.assignedTo) {
    primary.assignedTo = duplicate.assignedTo;
  }
  if (!primary.email && duplicate.email) primary.email = duplicate.email;
  if (!primary.contactNumber && duplicate.contactNumber) {
    primary.contactNumber = duplicate.contactNumber;
  }

  await primary.save();

  await cancelSequence(duplicate._id, "merged");

  duplicate.lifecycleState = "LOST";
  duplicate.status = "Merged";
  duplicate.mergedIntoLead = primary._id;
  duplicate.mergedAt = new Date();
  duplicate.mergedBy = userId;
  duplicate.remarks = duplicate.remarks
    ? `${duplicate.remarks}\n[Merged into lead ${primary.name}]`
    : `[Merged into lead ${primary.name}]`;
  await duplicate.save();

  if (isOrchestrationEnabled() && primary.correlationId) {
    await enqueueOutboxEvent({
      eventType: "lead.merged",
      aggregateType: "Lead",
      aggregateId: primary._id,
      correlationId: primary.correlationId,
      schemaVersion: 1,
      metadata: { actor: "user", actorId: userId },
      payload: {
        primaryLeadId: primary._id.toString(),
        duplicateLeadId: duplicate._id.toString(),
        reason,
        correlationId: primary.correlationId,
      },
    });
  }

  await logAutomationEvent({
    action: "lead_merged",
    resource: "Lead",
    resourceId: primary._id,
    entityName: primary.name,
    details: {
      duplicateLeadId: duplicate._id.toString(),
      duplicateName: duplicate.name,
      reason,
      mergedBy: userId?.toString(),
    },
  });

  return {
    success: true,
    primary,
    duplicate,
  };
}

module.exports = {
  findDuplicateCandidates,
  checkAndRaiseDuplicateOnCreate,
  mergeLeads,
  normalizePhone,
};
