const DomainEvent = require("../models/DomainEvent");
const AgentLog = require("../models/AgentLog");
const Opportunity = require("../models/Opportunity");
const agentActionService = require("./agentActionService");
const { tryAutoExecute, getAutomationActorId } = require("./agentAutomationService");
const templateService = require("./templateService");
const { enqueueOutboxEvent } = require("./outboxService");
const { isAiPaused } = require("./aiPauseService");
const linkFacade = require("../facades/linkFacade");
const { buildProposalPublicUrl } = require("../config/opportunityDealFlow");

const AGENT_NAME = "PropertyMatchingAgent";
const AGENT_VERSION = "1.1.0";
const TEMPLATE_ID = "client_properties_share_v1";

function formatRent(value) {
  const n = Number(String(value || "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return "On request";
  return `₹${n.toLocaleString("en-IN")}/month`;
}

function formatArea(summary = {}) {
  const area = summary.exactArea || summary.area;
  if (!area) return "Area on request";
  return `${area} sqft`;
}

function buildPropertyList(matches = []) {
  return matches
    .map((match, index) => {
      const s = match.propertySummary || {};
      const name = s.name || `Property option ${index + 1}`;
      const location = [s.roadName, s.city].filter(Boolean).join(", ") || "Location details on request";
      const lines = [
        `${index + 1}. ${name} — ${location}`,
        `   ${formatArea(s)} | Rent: ${formatRent(s.expectedRent)}`,
        `   Match score: ${match.score}/100`,
      ];
      if (match.explanation) {
        lines.push(`   Why: ${match.explanation.slice(0, 180)}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function buildProposalBlock(proposalInfo) {
  if (!proposalInfo?.proposalLink) return "";
  const name = proposalInfo.propertyName || "your selected property";
  return [
    "Detailed proposal (photos, floor plans, rent & area):",
    `${name}`,
    proposalInfo.proposalLink,
    "",
    "Open the link above to review the full proposal for option 1.",
  ].join("\n");
}

function buildTemplateVariables(client, matches, proposalInfo = null) {
  const top = matches[0];
  return {
    clientName: client.contactPerson || client.name,
    city: client.city || top?.propertySummary?.city || "your preferred city",
    matchCount: String(matches.length),
    propertyList: buildPropertyList(matches),
    proposalLink: proposalInfo?.proposalLink || "",
    proposalPropertyName: proposalInfo?.propertyName || top?.propertySummary?.name || "",
    proposalBlock: buildProposalBlock(proposalInfo),
    personalizedLine: client.preferredArea
      ? `Based on your preference for ${client.preferredArea}, here are our top matches:`
      : "Based on your requirements, here are our top property matches:",
  };
}

async function findExistingShareProposal(clientId, propertyIds = []) {
  for (const propertyId of propertyIds) {
    const opportunity = await Opportunity.findOne({
      client: clientId,
      property: propertyId,
    })
      .populate("property", "name")
      .lean();

    if (opportunity) {
      return {
        opportunityId: opportunity._id.toString(),
        propertyId: propertyId.toString(),
        propertyName: opportunity.property?.name,
        proposalLink: buildProposalPublicUrl(opportunity._id.toString()),
      };
    }
  }
  return null;
}

async function ensureTopPropertyLinkedForProposal(client, matches, actorUserId) {
  const top = matches[0];
  const topPropertyId = top?.propertyId;
  if (!topPropertyId) return null;

  const propertyIds = matches.map((m) => m.propertyId).filter(Boolean);
  const existing = await findExistingShareProposal(client._id, propertyIds);
  if (existing) return existing;

  if (!actorUserId) return null;

  const linkResult = await linkFacade.linkPropertyToClient({
    clientId: client._id,
    propertyId: topPropertyId,
    userId: actorUserId,
    actorMeta: {
      correlationId: client.correlationId,
      actor: `agent:${AGENT_NAME}`,
    },
    skipNotifications: true,
  });

  if (linkResult.error || !linkResult.opportunity) return null;

  return {
    opportunityId: linkResult.opportunity._id.toString(),
    propertyId: topPropertyId.toString(),
    propertyName: linkResult.property?.name || top?.propertySummary?.name,
    proposalLink: buildProposalPublicUrl(linkResult.opportunity._id.toString()),
    linkedNow: Boolean(linkResult.isNew !== false),
  };
}

async function hasAlreadyShared(clientId, correlationId) {
  if (correlationId) {
    const shared = await DomainEvent.exists({
      correlationId,
      eventType: "properties.shared",
      "payload.clientId": clientId.toString(),
    });
    if (shared) return true;
  }

  const AgentAction = require("../models/AgentAction");
  const pendingShare = await AgentAction.findOne({
    entityType: "Client",
    entityId: clientId,
    intent: "send_email",
    status: "pending_approval",
    "payload.templateId": TEMPLATE_ID,
  }).lean();
  if (pendingShare) return true;

  return false;
}

/**
 * Draft (and optionally auto-send) an email listing matched properties for the client.
 */
async function proposePropertyShareEmail({
  client,
  matches,
  correlationId,
  triggerEventId,
  triggerEventType = "property.matched",
}) {
  if (!client?.email) {
    return { skipped: true, reason: "no_email" };
  }

  if (!matches?.length) {
    return { skipped: true, reason: "no_matches" };
  }

  if (await isAiPaused(correlationId)) {
    return { skipped: true, reason: "ai_paused" };
  }

  if (await hasAlreadyShared(client._id, correlationId)) {
    return { skipped: true, reason: "already_shared_or_pending" };
  }

  const { getAutomationSettings } = require("./agentAutomationService");
  const automationSettings = await getAutomationSettings();
  const topScore = matches[0]?.score;
  const minShareScore = automationSettings.minPropertyShareScore ?? 60;

  if (typeof topScore === "number" && topScore < minShareScore) {
    const { raiseException } = require("./exceptionCenterService");
    await raiseException({
      type: "ai_low_confidence",
      correlationId,
      entityType: "Client",
      entityId: client._id,
      title: `Match score too low to email client — ${client.name}`,
      description: `Best match ${topScore}/100 is below minimum ${minShareScore} for property share email. Review matches in AI Hub or lower threshold.`,
      dedupeKey: `low_share_score:${client._id}:${topScore}`,
      payload: { clientId: client._id.toString(), topScore, minShareScore },
    });

    await AgentLog.create({
      correlationId,
      eventType: triggerEventType,
      workerName: "orchestrator",
      agentName: AGENT_NAME,
      message: `Property share email blocked — score ${topScore} < min ${minShareScore}`,
      result: "skipped",
      meta: { topScore, minShareScore },
    });

    return {
      skipped: true,
      reason: "below_min_share_score",
      topScore,
      minShareScore,
    };
  }

  const template = await templateService.getTemplate(TEMPLATE_ID);
  if (!template) {
    throw new Error(`Template not found: ${TEMPLATE_ID}`);
  }

  const actorUserId = await getAutomationActorId();
  const proposalInfo = await ensureTopPropertyLinkedForProposal(client, matches, actorUserId);
  const variables = buildTemplateVariables(client, matches, proposalInfo);
  const rendered = templateService.renderTemplate(template, variables);

  const action = await agentActionService.createAction({
    agentName: AGENT_NAME,
    agentVersion: AGENT_VERSION,
    intent: "send_email",
    entityType: "Client",
    entityId: client._id,
    correlationId,
    triggerEventId,
    payload: {
      channel: "email",
      templateId: TEMPLATE_ID,
      purpose: "share_properties",
      toEmail: client.email,
      subject: rendered.subject,
      body: rendered.body,
      variables: rendered.variables,
      propertyIds: matches.map((m) => m.propertyId),
      matchCount: matches.length,
      topScore: matches[0]?.score,
      proposalLinkIncluded: Boolean(proposalInfo?.proposalLink),
      opportunityId: proposalInfo?.opportunityId || null,
      proposalLink: proposalInfo?.proposalLink || null,
    },
    confidence: Math.min(0.95, (matches[0]?.score || 70) / 100),
    reasoning: proposalInfo?.proposalLink
      ? `Share ${matches.length} matched properties with proposal link for ${client.name}`
      : `Share ${matches.length} matched properties with ${client.name}`,
    status: "pending_approval",
  });

  await enqueueOutboxEvent({
    eventType: "properties.shared",
    aggregateType: "Client",
    aggregateId: client._id,
    correlationId,
    causationId: triggerEventId,
    schemaVersion: 1,
    metadata: { actor: `agent:${AGENT_NAME}` },
    payload: {
      clientId: client._id.toString(),
      correlationId,
      agentActionId: action._id.toString(),
      templateId: TEMPLATE_ID,
      propertyIds: matches.map((m) => m.propertyId),
      matchCount: matches.length,
      toEmail: client.email,
      proposalLinkIncluded: Boolean(proposalInfo?.proposalLink),
      opportunityId: proposalInfo?.opportunityId || null,
      proposalLink: proposalInfo?.proposalLink || null,
    },
  });

  await enqueueOutboxEvent({
    eventType: "agent.action_proposed",
    aggregateType: "AgentAction",
    aggregateId: action._id,
    correlationId,
    causationId: triggerEventId,
    schemaVersion: 1,
    metadata: { actor: `agent:${AGENT_NAME}` },
    payload: {
      agentActionId: action._id.toString(),
      agentName: AGENT_NAME,
      intent: "send_email",
      purpose: "share_properties",
      correlationId,
    },
  });

  await AgentLog.create({
    correlationId,
    eventId: triggerEventId,
    eventType: triggerEventType,
    workerName: "orchestrator",
    agentName: AGENT_NAME,
    message: proposalInfo?.proposalLink
      ? `Drafted property share email with proposal link (${matches.length} options) for ${client.email}`
      : `Drafted property share email (${matches.length} options) for ${client.email}`,
    result: "success",
    meta: {
      agentActionId: action._id.toString(),
      matchCount: matches.length,
      proposalLinkIncluded: Boolean(proposalInfo?.proposalLink),
    },
  });

  const auto = await tryAutoExecute(action);

  return {
    drafted: true,
    agentActionId: action._id.toString(),
    autoSent: Boolean(auto.executed),
    matchCount: matches.length,
    proposalLinkIncluded: Boolean(proposalInfo?.proposalLink),
    proposalLink: proposalInfo?.proposalLink || null,
  };
}

module.exports = {
  AGENT_NAME,
  TEMPLATE_ID,
  buildPropertyList,
  buildTemplateVariables,
  buildProposalBlock,
  ensureTopPropertyLinkedForProposal,
  proposePropertyShareEmail,
};
