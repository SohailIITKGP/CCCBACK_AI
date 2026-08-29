const Client = require("../models/Client");
const Property = require("../models/propertyModel");
const Opportunity = require("../models/Opportunity");
const User = require("../models/User");
const createNotification = require("../utils/notification");
const { sendMailSafe, getEmailFrom } = require("../utils/smtpTransporter");
const { buildReminderStateForStatus } = require("../services/opportunityReminderService");
const { enqueueOutboxEvent } = require("../services/outboxService");
const { isOrchestrationEnabled } = require("../config/orchestration");
const processManagerService = require("../services/processManagerService");
const {
  buildOverridePreview,
  supersedePriorOpportunities,
  validateOverrideReason,
  findAiSuggestedProperty,
  scorePropertyForClientId,
  supersedeOpportunity,
} = require("../services/propertyOverrideService");
const { cancelAllProposalTimers } = require("../services/opportunityProposalStaleService");

/**
 * Link property to client and create opportunity if needed.
 * Detects AI/manual overrides and supersedes prior proposals.
 */
async function linkPropertyToClient({
  clientId,
  propertyId,
  userId,
  actorMeta = {},
  skipNotifications = false,
  overrideReason = null,
  overrideReasonNote = null,
}) {
  const client = await Client.findById(clientId).populate("whoConverted", "name email role");
  const property = await Property.findById(propertyId);
  const user = userId ? await User.findById(userId).select("name email role") : null;

  if (!client || !property) {
    return { error: "not_found", message: "Client or Property not found" };
  }

  if (property.propertyStatus !== "approved") {
    return { error: "property_not_approved", message: "Property is not approved for linking" };
  }

  const correlationId = client.correlationId || actorMeta.correlationId;
  const preview = await buildOverridePreview({
    clientId,
    propertyId,
    correlationId,
  });

  const reasonCheck = validateOverrideReason(
    preview.requiresOverrideReason,
    overrideReason,
    overrideReasonNote
  );
  if (!reasonCheck.valid) {
    return {
      error: reasonCheck.error,
      message: reasonCheck.message,
      preview,
    };
  }

  client.linkedProperties = client.linkedProperties || [];
  client.linkedProperties = [...new Set([...client.linkedProperties.map(String), String(propertyId)])];

  property.linkedClients = property.linkedClients || [];
  property.linkedClients = [...new Set([...property.linkedClients.map(String), String(clientId)])];

  let opportunity = await Opportunity.findOne({ client: clientId, property: propertyId });
  const isNewOpportunity = !opportunity;

  if (!opportunity) {
    opportunity = new Opportunity({
      client: clientId,
      property: propertyId,
      whoLinkthis: userId,
      reminderState: buildReminderStateForStatus("Pending"),
    });
    await opportunity.save();

    client.opportunities = client.opportunities || [];
    client.opportunities.push(opportunity._id);
    property.opportunities = property.opportunities || [];
    property.opportunities.push(opportunity._id);
    if (userId) property.whoLinkthis = userId;
    await property.save();
  }

  const { regenerateReminderScheduleTasks } = require("../services/followUpTaskService");
  await opportunity.populate([
    { path: "client", select: "name email phone" },
    { path: "property", select: "name address whoCreated" },
  ]);
  regenerateReminderScheduleTasks(opportunity).catch((err) =>
    console.error("[linkFacade] reminder task schedule failed:", err.message)
  );

  if (!isNewOpportunity) {
    await client.save();
    return {
      success: true,
      isNew: false,
      isOverride: false,
      message: "Opportunity already exists for this client and property.",
      opportunity,
      client,
      property,
    };
  }

  const aiSuggestion = preview.aiSuggestion || (await findAiSuggestedProperty(clientId, correlationId));
  const newPropertyScore =
    preview.newPropertyScore ?? (await scorePropertyForClientId(clientId, propertyId));
  const isOverride = preview.requiresOverrideReason;

  let superseded = [];
  if (isOverride) {
    superseded = await supersedePriorOpportunities({
      clientId,
      newPropertyId: propertyId,
      newOpportunityId: opportunity._id,
      overrideReason,
      overrideReasonNote,
      actorUserId: userId,
      correlationId,
      aiSuggestion,
      newPropertyScore,
    });
  }

  await client.save();

  const previousPropertyId =
    preview.activeOpportunities[0]?.propertyId ||
    (aiSuggestion?.propertyId !== String(propertyId) ? aiSuggestion?.propertyId : null);

  if (isOrchestrationEnabled() && correlationId) {
    const linkEventType = isOverride ? "property.override_linked" : "property.linked";

    if (isOverride) {
      await enqueueOutboxEvent({
        eventType: linkEventType,
        aggregateType: "Client",
        aggregateId: client._id,
        correlationId,
        schemaVersion: 1,
        metadata: {
          actor: actorMeta.actor || "user",
          actorId: userId || null,
          ipAddress: actorMeta.ipAddress || null,
        },
        payload: {
          clientId: client._id.toString(),
          previousPropertyId: previousPropertyId || null,
          newPropertyId: property._id.toString(),
          newOpportunityId: opportunity._id.toString(),
          correlationId,
          overrideReason,
          overrideReasonNote: overrideReasonNote || null,
          aiPropertyId: aiSuggestion?.propertyId || null,
          aiScore: aiSuggestion?.score ?? null,
          newPropertyScore,
          supersededOpportunityIds: superseded
            .filter((s) => s.superseded)
            .map((s) => s.opportunityId),
          actorId: userId?.toString() || null,
        },
      });
    } else {
      await enqueueOutboxEvent({
        eventType: linkEventType,
        aggregateType: "Client",
        aggregateId: client._id,
        correlationId,
        schemaVersion: 1,
        metadata: {
          actor: actorMeta.actor || "user",
          actorId: userId || null,
          ipAddress: actorMeta.ipAddress || null,
        },
        payload: {
          clientId: client._id.toString(),
          propertyId: property._id.toString(),
          opportunityId: opportunity._id.toString(),
          correlationId,
        },
      });
    }

    await enqueueOutboxEvent({
      eventType: "opportunity.created",
      aggregateType: "Opportunity",
      aggregateId: opportunity._id,
      correlationId,
      schemaVersion: 1,
      metadata: {
        actor: actorMeta.actor || "user",
        actorId: userId || null,
      },
      payload: {
        opportunityId: opportunity._id.toString(),
        clientId: client._id.toString(),
        propertyId: property._id.toString(),
        correlationId,
        isOverride,
        overrideReason: overrideReason || null,
      },
    });

    await processManagerService.onPropertyLinked(correlationId);
  }

  if (!skipNotifications && user) {
    try {
      await createNotification(
        "Opportunity",
        isOverride ? "Property override" : "Created",
        opportunity._id,
        `${client.name} - ${property.name}`,
        userId,
        isOverride
          ? `Property switched to ${property.name}${overrideReason ? ` (${overrideReason})` : ""}`
          : `Opportunity created between ${client.name} and ${property.name}`
      );
    } catch (err) {
      console.error("[linkFacade] notification failed:", err.message);
    }

    await sendLinkEmails({ user, client, property, isOverride }).catch((err) =>
      console.error("[linkFacade] email notification failed:", err.message)
    );
  }

  return {
    success: true,
    isNew: true,
    isOverride,
    overrideReason,
    supersededCount: superseded.filter((s) => s.superseded).length,
    message: isOverride
      ? "Property linked — prior proposal superseded"
      : "Property linked to client and opportunity created",
    opportunity,
    client,
    property,
    preview: isOverride ? preview : undefined,
  };
}

async function unlinkPropertyFromClient({
  clientId,
  propertyId,
  userId,
  actorMeta = {},
}) {
  const client = await Client.findById(clientId).select("name correlationId linkedProperties");
  const property = await Property.findById(propertyId).select("name linkedClients");

  if (!client || !property) {
    return { error: "not_found", message: "Client or Property not found" };
  }

  const opportunity = await Opportunity.findOne({
    client: clientId,
    property: propertyId,
    proposalStatus: { $ne: "superseded" },
  }).lean();

  const correlationId = client.correlationId || actorMeta.correlationId;

  if (opportunity && correlationId && isOrchestrationEnabled()) {
    if (opportunity.proposalEmailSentAt) {
      await supersedeOpportunity({
        opportunity,
        supersededByOpportunityId: null,
        meta: { overrideReason: "property_unlinked" },
        actorUserId: userId,
        correlationId,
      });
    } else {
      await cancelAllProposalTimers(opportunity._id.toString());
    }
  }

  await Client.findByIdAndUpdate(clientId, {
    $pull: { linkedProperties: propertyId },
  });

  await Property.findByIdAndUpdate(propertyId, {
    $pull: { linkedClients: clientId },
  });

  if (isOrchestrationEnabled() && correlationId) {
    await enqueueOutboxEvent({
      eventType: "property.unlinked",
      aggregateType: "Client",
      aggregateId: clientId,
      correlationId,
      schemaVersion: 1,
      metadata: {
        actor: actorMeta.actor || "user",
        actorId: userId || null,
        ipAddress: actorMeta.ipAddress || null,
      },
      payload: {
        clientId: clientId.toString(),
        propertyId: propertyId.toString(),
        opportunityId: opportunity?._id?.toString() || null,
        correlationId,
        hadProposalSent: Boolean(opportunity?.proposalEmailSentAt),
      },
    });
  }

  return {
    success: true,
    message: "Property unlinked from client",
    opportunityId: opportunity?._id?.toString() || null,
    hadProposalSent: Boolean(opportunity?.proposalEmailSentAt),
  };
}

async function sendLinkEmails({ user, client, property, isOverride = false }) {
  let recipients = [];

  if (user.role === "FE-Property") {
    const creator = await User.findById(client.whoConverted).select("name email role");
    if (creator) recipients.push(creator);
    const managers = await User.find({ role: "Manager" }).select("name email");
    recipients.push(...managers);
  } else if (["BO-Client", "Lead-Employee"].includes(user.role)) {
    const admins = await User.find({ role: { $in: ["Manager", "Super Admin"] } }).select("name email");
    recipients.push(...admins);
  }

  recipients = recipients.filter(
    (r, i, self) => r?.email && i === self.findIndex((x) => x.email === r.email)
  );

  const from = getEmailFrom();
  if (!from || !recipients.length) return;

  const emailContent = `
    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
      <h2>${isOverride ? "Property Override — Client Link Updated" : "New Property-Client Link Created"}</h2>
      <p>${user.name} (${user.role}) ${isOverride ? "switched the linked property" : "linked a property to a client"}.</p>
      <ul>
        <li><strong>Client:</strong> ${client.name}</li>
        <li><strong>Property:</strong> ${property.name}, ${property.address || ""}</li>
      </ul>
    </div>`;

  await Promise.allSettled(
    recipients.map((recipient) =>
      sendMailSafe({
        from,
        to: recipient.email,
        subject: isOverride
          ? "Property override — client link updated"
          : "New Property-Client Link Created",
        html: emailContent,
      })
    )
  );
}

module.exports = {
  linkPropertyToClient,
  unlinkPropertyFromClient,
};
