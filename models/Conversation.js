const mongoose = require("mongoose");

const channelEntrySchema = new mongoose.Schema(
  {
    channel: {
      type: String,
      enum: ["email", "whatsapp", "call", "crm_note"],
      required: true,
    },
    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
    },
    content: { type: String, default: "" },
    subject: { type: String, default: "" },
    summary: { type: String, default: "" },
    externalMessageId: { type: String, default: null, index: true },
    templateId: { type: String, default: null },
    timestamp: { type: Date, default: Date.now },
    actor: { type: String, default: "system" },
  },
  { _id: true }
);

const conversationSchema = new mongoose.Schema(
  {
    correlationId: { type: String, required: true, index: true },
    entityType: {
      type: String,
      enum: ["Lead", "Client", "Opportunity"],
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    channels: [channelEntrySchema],
    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },
    awaitingReplyFrom: {
      type: String,
      enum: [null, "client", "internal"],
      default: null,
    },
  },
  { timestamps: true }
);

conversationSchema.index({ correlationId: 1, entityType: 1 });

module.exports = mongoose.model("Conversation", conversationSchema);
