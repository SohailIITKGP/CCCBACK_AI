const Lead = require("../models/Lead");
const Client = require("../models/Client");
const Conversation = require("../models/Conversation");
const conversationService = require("./conversationService");

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeMessageId(id) {
  if (!id) return "";
  return String(id).trim().replace(/^<|>$/g, "");
}

const IGNORED_FROM_PATTERNS = [
  /noreply|no-reply|donotreply|mailer-daemon|newsletter|notifications?@/i,
  /@linkedin\.com$|@uber\.com$|@indeed\.com$|@substack\.com$|@clickup\.com$/i,
];

function isIgnoredMarketingEmail(fromEmail, subject = "") {
  const from = normalizeEmail(fromEmail);
  if (!from) return true;
  if (IGNORED_FROM_PATTERNS.some((re) => re.test(from))) return true;
  if (/^unsubscribe|^newsletter/i.test(subject)) return true;
  return false;
}

function isLikelyCrmReply({ fromEmail, subject, inReplyTo, references, crmEmail }) {
  const from = normalizeEmail(fromEmail);
  const subj = String(subject || "").trim();
  if (/^re:/i.test(subj)) return true;
  if (inReplyTo || (references && references.length)) return true;
  if (crmEmail && from === crmEmail && /^re:/i.test(subj)) return true;
  return false;
}

async function resolveEntityByEmail({ correlationId, leadId, clientId, email }) {
  if (correlationId) {
    const lead = await Lead.findOne({ correlationId }).select("_id correlationId email").lean();
    if (lead) return { entityType: "Lead", entityId: lead._id, correlationId, email: lead.email };
    const client = await Client.findOne({ correlationId }).select("_id correlationId email").lean();
    if (client) return { entityType: "Client", entityId: client._id, correlationId, email: client.email };
  }
  if (leadId) {
    const lead = await Lead.findById(leadId).select("_id correlationId email").lean();
    if (lead) return { entityType: "Lead", entityId: lead._id, correlationId: lead.correlationId, email: lead.email };
  }
  if (clientId) {
    const client = await Client.findById(clientId).select("_id correlationId email").lean();
    if (client) return { entityType: "Client", entityId: client._id, correlationId: client.correlationId, email: client.email };
  }
  if (email) {
    const normalized = normalizeEmail(email);
    const lead = await Lead.findOne({
      email: new RegExp(`^${escapeRegex(normalized)}$`, "i"),
      isConverted: { $ne: true },
    })
      .select("_id correlationId email")
      .sort({ createdAt: -1 })
      .lean();
    if (lead?.correlationId) {
      return { entityType: "Lead", entityId: lead._id, correlationId: lead.correlationId, email: lead.email };
    }
    const client = await Client.findOne({ email: new RegExp(`^${escapeRegex(normalized)}$`, "i") })
      .select("_id correlationId email")
      .lean();
    if (client?.correlationId) {
      return { entityType: "Client", entityId: client._id, correlationId: client.correlationId, email: client.email };
    }
  }
  return null;
}

async function resolveEntityByThread({ inReplyTo, references = [] }) {
  const refIds = [inReplyTo, ...(references || [])]
    .filter(Boolean)
    .flatMap((r) => String(r).split(/\s+/))
    .map(normalizeMessageId)
    .filter(Boolean);

  if (!refIds.length) return null;

  const conv = await Conversation.findOne({
    channels: {
      $elemMatch: {
        direction: "outbound",
        externalMessageId: {
          $in: refIds.concat(refIds.map((id) => `<${id}>`)),
        },
      },
    },
  })
    .sort({ lastOutboundAt: -1 })
    .lean();

  if (conv) {
    return {
      entityType: conv.entityType,
      entityId: conv.entityId,
      correlationId: conv.correlationId,
    };
  }

  // Also match stored Gmail API ids embedded in references (partial)
  for (const ref of refIds) {
    const byGmailId = await Conversation.findOne({
      "channels.externalMessageId": ref,
      "channels.direction": "outbound",
    }).lean();
    if (byGmailId) {
      return {
        entityType: byGmailId.entityType,
        entityId: byGmailId.entityId,
        correlationId: byGmailId.correlationId,
      };
    }
  }

  return null;
}

async function resolveLatestAwaitingConversation() {
  return Conversation.findOne({
    awaitingReplyFrom: "client",
    lastOutboundAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
  })
    .sort({ lastOutboundAt: -1 })
    .lean();
}

async function resolveEntityForInbound({
  email,
  inReplyTo,
  references,
  subject,
  crmEmail,
}) {
  let entity = await resolveEntityByEmail({ email });
  if (entity?.correlationId) return { ...entity, matchedBy: "from_email" };

  entity = await resolveEntityByThread({ inReplyTo, references });
  if (entity?.correlationId) return { ...entity, matchedBy: "thread" };

  if (/^re:/i.test(String(subject || ""))) {
    const recent = await resolveLatestAwaitingConversation();
    if (recent) {
      return {
        entityType: recent.entityType,
        entityId: recent.entityId,
        correlationId: recent.correlationId,
        matchedBy: "recent_outbound",
      };
    }
  }

  if (crmEmail && normalizeEmail(email) === normalizeEmail(crmEmail) && /^re:/i.test(subject || "")) {
    const recent = await resolveLatestAwaitingConversation();
    if (recent) {
      return {
        entityType: recent.entityType,
        entityId: recent.entityId,
        correlationId: recent.correlationId,
        matchedBy: "crm_self_reply",
      };
    }
  }

  return null;
}

async function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  const norm = normalizeMessageId(messageId);
  return Conversation.exists({
    $or: [
      { "channels.externalMessageId": messageId },
      { "channels.externalMessageId": norm },
      { "channels.externalMessageId": `<${norm}>` },
    ],
  });
}

/**
 * Record inbound email and enqueue message.replied for the worker.
 */
async function processInboundEmail({
  fromEmail,
  from,
  subject = "",
  body = "",
  text = "",
  html = "",
  messageId = null,
  inReplyTo = null,
  references = [],
  source = "webhook",
  crmEmail = null,
}) {
  const email = normalizeEmail(fromEmail || from);
  const content = body || text || html || "";

  if (!email) {
    return { error: "missing_sender", message: "fromEmail is required" };
  }

  if (messageId && (await isDuplicateMessage(messageId))) {
    return { skipped: true, reason: "duplicate_message", messageId };
  }

  const entity = await resolveEntityForInbound({
    email,
    inReplyTo,
    references,
    subject,
    crmEmail,
  });

  if (!entity?.correlationId) {
    return { error: "entity_not_found", message: "No lead/client found for this email" };
  }

  const result = await conversationService.recordInboundReply({
    correlationId: entity.correlationId,
    entityType: entity.entityType,
    entityId: entity.entityId,
    channel: "email",
    content,
    subject,
    externalMessageId: messageId,
    actor: email,
  });

  if (result.error) {
    return result;
  }

  if (entity.entityType === "Lead") {
    try {
      const { processLeadReplyAfterInbound } = require("./leadEmailConversionService");
      await processLeadReplyAfterInbound({
        leadId: entity.entityId,
        correlationId: entity.correlationId,
        content,
        subject,
        messageId,
        fromEmail: email,
        matchedBy: entity.matchedBy,
      });
    } catch (err) {
      console.error("[inbound] lead reply processing failed:", err.message);
    }
  }

  if (entity.entityType === "Client") {
    try {
      const { handleClientEmailReply } = require("./clientEmailReplyService");
      const { getAutomationActorId } = require("./agentAutomationService");
      const actorUserId = await getAutomationActorId();
      await handleClientEmailReply({
        clientId: entity.entityId,
        correlationId: entity.correlationId,
        content,
        subject,
        messageId,
        actorUserId,
      });
    } catch (err) {
      console.error("[inbound] client reply processing failed:", err.message);
    }
  }

  return {
    success: true,
    source,
    correlationId: entity.correlationId,
    entityType: entity.entityType,
    entityId: entity.entityId.toString(),
    matchedBy: entity.matchedBy,
    channelCount: result.conversation?.channels?.length,
  };
}

/** Parse SendGrid/Mailgun-style multipart webhook fields. */
function parseProviderPayload(body) {
  if (!body || typeof body !== "object") return body;
  const fromRaw = body.from || body.sender || body.envelope || "";
  const fromMatch = String(fromRaw).match(/<([^>]+)>/) || String(fromRaw).match(/([\w.+-]+@[\w.-]+\.\w+)/);
  const fromEmail = body.fromEmail || body.from_email || (fromMatch ? fromMatch[1] : fromRaw);

  return {
    fromEmail: String(fromEmail || "").trim(),
    subject: body.subject || "",
    body: body.body || body.text || "",
    text: body.text || "",
    html: body.html || "",
    messageId: body.messageId || body["message-id"] || body["Message-Id"] || null,
  };
}

module.exports = {
  processInboundEmail,
  parseProviderPayload,
  resolveEntityByEmail,
  resolveEntityForInbound,
  isDuplicateMessage,
  isIgnoredMarketingEmail,
  isLikelyCrmReply,
};
