const mongoose = require("mongoose");

/**
 * Append-only activity trail for WorkTodo.
 * Never update or delete rows — required for performance investigations.
 */
const EVENT_TYPES = [
  "task_created",
  "task_assigned",
  "task_reassigned",
  "task_started",
  "deadline_changed",
  "reminder_created",
  "reminder_sent",
  "task_rescheduled",
  "comment_added",
  "attachment_added",
  "task_completed",
  "task_reopened",
  "task_cancelled",
  "status_changed",
  "priority_changed",
  "collaborators_changed",
  "crm_link_changed",
];

const todoActivitySchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      required: true,
      enum: EVENT_TYPES,
      index: true,
    },
    todoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkTodo",
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

todoActivitySchema.index({ todoId: 1, timestamp: 1 });

module.exports = mongoose.model("TodoActivity", todoActivitySchema);
module.exports.EVENT_TYPES = EVENT_TYPES;
