const mongoose = require("mongoose");

const followUpTaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: "" },

    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    entityType: {
      type: String,
      enum: ["opportunity", "lead"],
      default: "opportunity",
      index: true,
    },

    opportunity: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Opportunity",
      index: true,
    },

    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lead",
      index: true,
    },

    clientName: { type: String, default: "" },
    propertyName: { type: String, default: "" },
    opportunityStatus: { type: String, default: "" },
    leadName: { type: String, default: "" },
    leadStatus: { type: String, default: "" },

    taskType: {
      type: String,
      enum: ["reminder", "follow_up", "site_visit"],
      required: true,
      index: true,
    },

    priority: {
      type: String,
      enum: ["Low", "Medium", "High", "Hot"],
      default: "Medium",
      index: true,
    },

    /** Current deadline (may change on reschedule). */
    dueDate: { type: Date, required: true, index: true },

    /** Immutable first deadline — never overwrite on reschedule. */
    originalDueAt: { type: Date, index: true },

    status: {
      type: String,
      enum: ["Pending", "In Progress", "Completed", "Cancelled", "Rescheduled"],
      default: "Pending",
      index: true,
    },

    startedAt: { type: Date },
    completedAt: { type: Date },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    completionNote: { type: String, default: "" },

    /** Set when completed: on_time | late | unknown (missing timestamps). */
    completionTiming: {
      type: String,
      enum: ["on_time", "late", "unknown", null],
      default: null,
    },

    expectedDurationMs: { type: Number, default: null },
    actualDurationMs: { type: Number, default: null },

    rescheduledCount: { type: Number, default: 0 },
    rescheduleHistory: [
      {
        fromDueAt: Date,
        toDueAt: Date,
        at: { type: Date, default: Date.now },
        by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        reason: { type: String, default: "" },
      },
    ],

    /**
     * false for legacy rows where completedAt/startedAt were never recorded.
     * Do not fabricate missing history.
     */
    timingDataAvailable: { type: Boolean, default: true },

    sourceKey: { type: String, required: true, unique: true, index: true },
    commentId: { type: mongoose.Schema.Types.ObjectId },
    reminderNumber: { type: Number },
    reminderTotal: { type: Number },
    reminderRuleId: { type: String, default: "" },
    reminderInstanceId: { type: String, default: "" },

    scheduleCadence: { type: String, default: "" },

    emailSubject: { type: String, default: "" },
    emailMessage: { type: String, default: "" },
    emailSentAt: { type: Date },

    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

followUpTaskSchema.index({ assignedTo: 1, status: 1, dueDate: 1 });
followUpTaskSchema.index({ status: 1, dueDate: 1 });
followUpTaskSchema.index({ lead: 1, status: 1, dueDate: 1 });
followUpTaskSchema.index({ assignedTo: 1, completionTiming: 1, completedAt: 1 });
followUpTaskSchema.index({ originalDueAt: 1 });

followUpTaskSchema.pre("validate", function validateEntity(next) {
  if (this.entityType === "lead") {
    if (!this.lead) return next(new Error("lead is required for lead tasks"));
  } else if (!this.opportunity) {
    return next(new Error("opportunity is required for opportunity tasks"));
  }
  if (!this.originalDueAt && this.dueDate) {
    this.originalDueAt = this.dueDate;
  }
  return next();
});

module.exports = mongoose.model("FollowUpTask", followUpTaskSchema);
