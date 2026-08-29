const mongoose = require("mongoose");

const leadSchema = new mongoose.Schema({
  name: { type: String, required: true },
  contactNumber: { type: String },
  contactPerson: { type: String },
  email: { type: String },
  state: { type: String },
  designation: { type: String },
  sourceOfConnection: { type: String },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  whoassign: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  whenassign: { type: Date },
  priority: { type: String, enum: ["Hot", "High", "Medium", "Cold", "Low"]},
  kindOfBusiness: { type: String },
  format: {
    type: String,
    enum: ["High Level", "Medium Level", "Affordable"],
  },
  clusters: [{ type: String }],
  remarks: { type: String },
  isRead: { type: Boolean, default: false },
  date: { type: Date, default: Date.now },
  isConverted: { type: Boolean, default: false },
  whoConverted: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  convertedAt: { type: Date }, 
  status: {
    type: String,
    default: "Pending",
  },

  /** Automated nurturing reminder cadence (same shape as Opportunity.reminderState). */
  reminderState: {
    status: { type: String },
    statusSetAt: { type: Date },
    remindersSent: { type: Number, default: 0 },
    lastReminderAt: { type: Date },
    nextReminderAt: { type: Date, index: true },
    completed: { type: Boolean, default: false },
  },

  /** Automated AI nurture sequence (Day 0 / 3 / 7 emails). */
  aiFollowUpState: {
    status: {
      type: String,
      enum: ["active", "cancelled", "completed"],
      default: null,
    },
    currentStep: { type: Number, default: 0 },
    stepsCompleted: { type: Number, default: 0 },
    startedAt: { type: Date },
    lastStepAt: { type: Date },
    nextStepAt: { type: Date, index: true },
    cancelledAt: { type: Date },
    cancelReason: { type: String },
    completedAt: { type: Date },
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  convertedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Client" },
  /** Links all journey events for this lead (Phase 0 orchestration). */
  correlationId: { type: String, index: true },
  lifecycleState: {
    type: String,
    enum: ["NEW", "CONTACTED", "ENGAGED", "QUALIFIED", "DORMANT", "LOST", "CONVERTED"],
    default: "NEW",
    index: true,
  },
  mergedIntoLead: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null, index: true },
  mergedAt: { type: Date },
  mergedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
});

// Add indexes for performance optimization
leadSchema.index({ name: 1 });
leadSchema.index({ email: 1 });
leadSchema.index({ contactNumber: 1 });
leadSchema.index({ priority: 1 });
leadSchema.index({ assignedTo: 1 });
leadSchema.index({ createdBy: 1 });
leadSchema.index({ isConverted: 1 });
leadSchema.index({ createdAt: -1 });
leadSchema.index({ status: 1 });

module.exports = mongoose.model("Lead", leadSchema);
