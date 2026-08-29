const mongoose = require("mongoose");

/**
 * Work teams for the independent To-Do module.
 * Coordinator maps to the "Team Coordinator" permission without adding a User.role.
 */
const teamSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      default: "",
      maxlength: 2000,
    },
    coordinator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    members: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
      index: true,
    },
  },
  { timestamps: true }
);

teamSchema.index({ name: 1 }, { unique: true });
teamSchema.index({ members: 1, status: 1 });

module.exports = mongoose.model("Team", teamSchema);
