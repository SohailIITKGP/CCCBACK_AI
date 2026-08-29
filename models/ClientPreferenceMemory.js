const mongoose = require("mongoose");

const preferenceEntrySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: true,
      enum: [
        "category_prefer",
        "category_avoid",
        "area_prefer",
        "area_avoid",
        "property_rejected",
        "property_preferred",
        "price_ceiling",
        "price_sensitive",
        "feature_note",
      ],
    },
    value: { type: String, default: "" },
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: "Property", default: null },
    source: {
      type: String,
      enum: ["override", "client_reply", "employee_activity", "manual", "system"],
      default: "system",
    },
    evidence: { type: String, default: "" },
    confidence: { type: Number, default: 0.75, min: 0, max: 1 },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

const clientPreferenceMemorySchema = new mongoose.Schema(
  {
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      unique: true,
      index: true,
    },
    correlationId: { type: String, index: true },
    entries: [preferenceEntrySchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model("ClientPreferenceMemory", clientPreferenceMemorySchema);
