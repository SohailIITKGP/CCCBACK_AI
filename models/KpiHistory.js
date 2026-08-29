const mongoose = require("mongoose");

const kpiHistorySchema = new mongoose.Schema(
  {
    period: {
      type: String,
      enum: ["weekly", "monthly", "quarterly", "yearly"],
      required: true,
      index: true,
    },
    periodEnd: { type: Date, required: true, index: true },
    metrics: {
      efficiencyScore: { type: Number },
      leadToClientConversion: { type: Number },
      overdueTasks: { type: Number },
      stuckDeals: { type: Number },
      proposalToCloseRate: { type: Number },
      responseTimeHours: { type: Number },
      leadsCreated: { type: Number },
      leadsConverted: { type: Number },
    },
  },
  { timestamps: true }
);

kpiHistorySchema.index({ period: 1, periodEnd: -1 }, { unique: true });

module.exports = mongoose.model("KpiHistory", kpiHistorySchema);
