const mongoose = require("mongoose");

const STATUSES = ["To Do", "In Progress", "Completed", "Cancelled"];
const PRIORITIES = ["Low", "Medium", "High", "Urgent"];
const SOURCE_TYPES = [
  "GENERAL",
  "PERSONAL",
  "LEAD",
  "CLIENT",
  "OPPORTUNITY",
  "PROPERTY",
];
const CATEGORIES = [
  "General",
  "Report",
  "Meeting",
  "Research",
  "Admin",
  "Development",
  "Site Visit",
  "Other",
];
const RECURRENCE_FREQUENCIES = ["none", "daily", "weekly", "monthly", "custom"];

const reminderSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["relative", "absolute"], default: "relative" },
    offsetMinutes: { type: Number, default: null, min: 0, max: 60 * 24 * 30 },
    remindAt: { type: Date, index: true },
    label: { type: String, default: "", maxlength: 80 },
    sentAt: { type: Date, default: null },
  },
  { _id: true }
);

const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 255 },
    url: { type: String, required: true, maxlength: 2000 },
    mimeType: { type: String, default: "", maxlength: 120 },
    size: { type: Number, default: null, min: 0, max: 50 * 1024 * 1024 },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const commentSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, maxlength: 4000 },
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const workTodoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: "", maxlength: 10000 },

    status: {
      type: String,
      enum: STATUSES,
      default: "To Do",
      index: true,
    },
    priority: {
      type: String,
      enum: PRIORITIES,
      default: "Medium",
      index: true,
    },
    category: {
      type: String,
      enum: CATEGORIES,
      default: "General",
      index: true,
    },

    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    assignedTo: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    assignedAt: { type: Date, default: null, index: true },
    collaborators: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Team",
      default: null,
      index: true,
    },

    startAt: { type: Date, default: null, index: true },
    dueAt: { type: Date, default: null, index: true },
    /** Immutable first deadline — never overwrite on reschedule. */
    originalDueAt: { type: Date, default: null, index: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null, index: true },
    cancelledAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    completionNote: { type: String, default: "", maxlength: 2000 },
    completionTiming: {
      type: String,
      enum: ["on_time", "late", "unknown", null],
      default: null,
    },

    reminders: [reminderSchema],
    overdueNotifiedAt: { type: Date, default: null },

    recurrence: {
      enabled: { type: Boolean, default: false },
      frequency: {
        type: String,
        enum: RECURRENCE_FREQUENCIES,
        default: "none",
      },
      interval: { type: Number, default: 1, min: 1, max: 30 },
      daysOfWeek: [{ type: Number, min: 0, max: 6 }],
      dayOfMonth: { type: Number, default: null, min: 1, max: 31 },
      until: { type: Date, default: null },
      customCron: { type: String, default: "", maxlength: 80 },
    },
    parentTodoId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkTodo",
      default: null,
      index: true,
    },
    occurrenceDate: { type: Date, default: null },
    occurrenceKey: { type: String, default: null },

    sourceType: {
      type: String,
      enum: SOURCE_TYPES,
      default: "GENERAL",
      index: true,
    },
    sourceId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
    sourceName: { type: String, default: "", maxlength: 300 },

    attachments: [attachmentSchema],
    comments: [commentSchema],
  },
  { timestamps: true }
);

workTodoSchema.index({ assignedTo: 1, status: 1, dueAt: 1 });
workTodoSchema.index({ assignedBy: 1, createdAt: -1 });
workTodoSchema.index({ team: 1, status: 1, dueAt: 1 });
workTodoSchema.index({ sourceType: 1, sourceId: 1 });
workTodoSchema.index({ owner: 1, status: 1, dueAt: 1 });
workTodoSchema.index({ status: 1, dueAt: 1 });
workTodoSchema.index({ "reminders.remindAt": 1, "reminders.sentAt": 1 });
workTodoSchema.index({ occurrenceKey: 1 }, { unique: true, sparse: true });

workTodoSchema.pre("validate", function setOriginalDue(next) {
  if (!this.originalDueAt && this.dueAt) {
    this.originalDueAt = this.dueAt;
  }
  if (!this.assignedAt && this.assignedTo && this.assignedTo.length) {
    this.assignedAt = this.assignedAt || new Date();
  }
  next();
});

module.exports = mongoose.model("WorkTodo", workTodoSchema);
module.exports.STATUSES = STATUSES;
module.exports.PRIORITIES = PRIORITIES;
module.exports.SOURCE_TYPES = SOURCE_TYPES;
module.exports.CATEGORIES = CATEGORIES;
module.exports.RECURRENCE_FREQUENCIES = RECURRENCE_FREQUENCIES;
