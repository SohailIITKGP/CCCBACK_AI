const mongoose = require("mongoose");

/**
 * Append-only audit trail for FollowUpTask lifecycle events.
 * Never update/delete for performance investigations.
 */
const taskActivitySchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      required: true,
      enum: [
        "task_created",
        "task_assigned",
        "task_started",
        "task_completed",
        "task_reopened",
        "task_rescheduled",
        "due_date_changed",
        "priority_changed",
        "employee_changed",
        "reminder_sent",
        "reminder_failed",
        "task_cancelled",
        "status_changed",
      ],
      index: true,
    },
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FollowUpTask",
      required: true,
      index: true,
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    timestamp: { type: Date, default: Date.now, index: true },
    previousValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue: { type: mongoose.Schema.Types.Mixed, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: false }
);

taskActivitySchema.index({ taskId: 1, timestamp: 1 });

module.exports = mongoose.model("TaskActivity", taskActivitySchema);
