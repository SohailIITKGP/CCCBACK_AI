const mongoose = require("mongoose");

const communicationTemplateSchema = new mongoose.Schema(
  {
    templateId: { type: String, required: true, unique: true, index: true },
    channel: { type: String, enum: ["email"], default: "email" },
    purpose: { type: String, default: "" },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    allowedVariables: [{ type: String }],
    isActive: { type: Boolean, default: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CommunicationTemplate", communicationTemplateSchema);
