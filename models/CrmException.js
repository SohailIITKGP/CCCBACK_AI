const mongoose = require("mongoose");

const crmExceptionSchema = new mongoose.Schema(
  {
    exceptionId: { type: String, required: true, unique: true, index: true },
    type: { type: String, required: true, index: true },
    severity: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
      index: true,
    },
    status: {
      type: String,
      enum: ["open", "assigned", "resolved", "dismissed"],
      default: "open",
      index: true,
    },
    ownerRole: { type: String, required: true, index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    correlationId: { type: String, index: true },
    entityType: { type: String, default: null },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    title: { type: String, required: true },
    description: { type: String, default: "" },
    sourceEventId: { type: String, default: null },
    sourceEventType: { type: String, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    slaDueAt: { type: Date, index: true },
    resolvedAt: { type: Date },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    resolution: { type: String, default: "" },
    dedupeKey: { type: String, default: null, sparse: true, unique: true },
  },
  { timestamps: true }
);

crmExceptionSchema.index({ status: 1, ownerRole: 1, slaDueAt: 1 });
crmExceptionSchema.index({ correlationId: 1, createdAt: -1 });

module.exports = mongoose.model("CrmException", crmExceptionSchema);
