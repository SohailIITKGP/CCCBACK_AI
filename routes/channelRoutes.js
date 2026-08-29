const express = require("express");
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const conversationService = require("../services/conversationService");
const { processInboundEmail, parseProviderPayload } = require("../services/inboundEmailService");
const { getCrmEmailAddress } = require("../config/emailAccount");
const { isWhatsAppEnabled } = require("../services/whatsappService");
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRoles, ADMIN_ROLES } = require("../middlewares/roleMiddleware");

const router = express.Router();

function getInboundCrmEmail() {
  return getCrmEmailAddress() || null;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function verifyWebhookSecret(req, res, next) {
  const secret = process.env.CHANNEL_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(503).json({
      success: false,
      message: "CHANNEL_WEBHOOK_SECRET not configured",
    });
  }
  const provided =
    req.headers["x-webhook-secret"] ||
    req.headers["x-channel-secret"] ||
    req.query.secret;
  if (provided !== secret) {
    return res.status(401).json({ success: false, message: "Invalid webhook secret" });
  }
  return next();
}

async function resolveEntity({ correlationId, leadId, clientId, email }) {
  if (correlationId) {
    const lead = await Lead.findOne({ correlationId }).select("_id correlationId").lean();
    if (lead) return { entityType: "Lead", entityId: lead._id, correlationId };
    const client = await Client.findOne({ correlationId }).select("_id correlationId").lean();
    if (client) return { entityType: "Client", entityId: client._id, correlationId };
  }
  if (leadId) {
    const lead = await Lead.findById(leadId).select("_id correlationId").lean();
    if (lead) return { entityType: "Lead", entityId: lead._id, correlationId: lead.correlationId };
  }
  if (clientId) {
    const client = await Client.findById(clientId).select("_id correlationId").lean();
    if (client) return { entityType: "Client", entityId: client._id, correlationId: client.correlationId };
  }
  if (email) {
    const lead = await Lead.findOne({ email: new RegExp(`^${escapeRegex(email)}$`, "i") })
      .select("_id correlationId")
      .lean();
    if (lead?.correlationId) {
      return { entityType: "Lead", entityId: lead._id, correlationId: lead.correlationId };
    }
  }
  return null;
}

/** POST /api/channels/email/inbound — email reply webhook or provider POST */
router.post("/email/inbound", verifyWebhookSecret, async (req, res) => {
  try {
    const payload = parseProviderPayload(req.body);
    const result = await processInboundEmail({
      ...payload,
      inReplyTo: req.body.inReplyTo || req.body.in_reply_to || null,
      references: req.body.references || [],
      source: "webhook",
      crmEmail: getInboundCrmEmail(),
    });

    if (result.error === "entity_not_found") {
      return res.status(404).json({ success: false, message: result.message });
    }
    if (result.error) {
      return res.status(400).json({ success: false, message: result.message || result.error });
    }
    if (result.skipped) {
      return res.status(200).json({ success: true, skipped: true, reason: result.reason });
    }

    return res.status(200).json({
      success: true,
      message: "Inbound email recorded — worker will parse and respond",
      correlationId: result.correlationId,
      channelCount: result.channelCount,
    });
  } catch (err) {
    console.error("[channels] email inbound:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/** POST /api/channels/whatsapp/inbound — Meta/Twilio webhook stub */
router.post("/whatsapp/inbound", verifyWebhookSecret, async (req, res) => {
  try {
    if (!isWhatsAppEnabled()) {
      return res.status(503).json({
        success: false,
        message: "WhatsApp not enabled (set WHATSAPP_ENABLED=true and API credentials)",
      });
    }

    const {
      correlationId,
      leadId,
      from,
      body = "",
      messageId,
    } = req.body;

    const entity = await resolveEntity({ correlationId, leadId, email: null });
    if (!entity?.correlationId) {
      return res.status(404).json({ success: false, message: "Entity not found" });
    }

    await conversationService.recordInboundReply({
      correlationId: entity.correlationId,
      entityType: entity.entityType,
      entityId: entity.entityId,
      channel: "whatsapp",
      content: body,
      externalMessageId: messageId || null,
      actor: from || "whatsapp_client",
    });

    return res.status(200).json({ success: true, message: "WhatsApp inbound recorded" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get(
  "/conversation/:correlationId",
  authMiddleware,
  async (req, res) => {
    try {
      const conversation = await conversationService.getConversation(req.params.correlationId);
      if (!conversation) {
        return res.status(404).json({ success: false, message: "Conversation not found" });
      }
      return res.status(200).json({ success: true, conversation });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
