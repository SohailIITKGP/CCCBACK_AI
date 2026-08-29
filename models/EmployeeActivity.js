const mongoose = require("mongoose");

const employeeActivitySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    clientId: { type: mongoose.Schema.Types.ObjectId, ref: "Client", index: true },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", index: true },
    correlationId: { type: String, index: true },
    channel: {
      type: String,
      enum: ["phone", "whatsapp", "meeting", "site_visit", "email", "other"],
      default: "phone",
    },
    note: { type: String, required: true },
    parsedUpdates: { type: mongoose.Schema.Types.Mixed, default: {} },
    appliedUpdates: { type: mongoose.Schema.Types.Mixed, default: {} },
    requirementsChanged: { type: Boolean, default: false },
  },
  { timestamps: true }
);

employeeActivitySchema.index({ clientId: 1, createdAt: -1 });
employeeActivitySchema.index({ leadId: 1, createdAt: -1 });

module.exports = mongoose.model("EmployeeActivity", employeeActivitySchema);
