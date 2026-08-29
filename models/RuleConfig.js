const mongoose = require("mongoose");

const ruleConfigSchema = new mongoose.Schema(
  {
    configKey: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    sourceProposalId: { type: mongoose.Schema.Types.ObjectId, ref: "RuleChangeProposal" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RuleConfig", ruleConfigSchema);
