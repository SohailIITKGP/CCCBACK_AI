const {
  generateInsightReport,
  getLatestReport,
  getReportHistory,
  runScheduledWeeklyInsights,
} = require("../services/insights/insightGenerationService");
const { computeAtRiskOpportunities } = require("../services/insights/insightAggregationService");
const { getPeriodWindows } = require("../services/insights/periodUtils");

const INSIGHT_ROLES = ["Super Admin", "Manager"];

function requireInsightAccess(req, res) {
  if (!req.user) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return false;
  }
  if (!INSIGHT_ROLES.includes(req.user.role)) {
    res.status(403).json({
      success: false,
      message: "Access denied. Managers and Super Admin only.",
    });
    return false;
  }
  return true;
}

function requireSuperAdmin(req, res) {
  if (!requireInsightAccess(req, res)) return false;
  if (req.user.role !== "Super Admin") {
    res.status(403).json({ success: false, message: "Super Admin only." });
    return false;
  }
  return true;
}

const VALID_PERIODS = ["weekly", "monthly", "quarterly", "yearly"];

function parsePeriod(value) {
  const p = String(value || "weekly").toLowerCase();
  return VALID_PERIODS.includes(p) ? p : "weekly";
}

exports.getLatestInsight = async (req, res) => {
  try {
    if (!requireInsightAccess(req, res)) return;

    const period = parsePeriod(req.query.period);
    let report = await getLatestReport(period);

    if (!report && req.query.generateIfMissing === "true") {
      const created = await generateInsightReport({ period, generatedBy: "api" });
      report = created.toObject ? created.toObject() : created;
    }

    if (!report) {
      return res.status(404).json({
        success: false,
        message: "No insight report found. Super Admin can POST /insights/generate to create one.",
      });
    }

    res.status(200).json({
      success: true,
      report: {
        _id: report._id,
        period: report.period,
        periodStart: report.periodStart,
        periodEnd: report.periodEnd,
        generatedAt: report.generatedAt,
        emailDigest: report.emailDigest,
        document: report.document,
      },
    });
  } catch (error) {
    console.error("[insightController] getLatestInsight:", error);
    res.status(500).json({ success: false, message: "Failed to load insight report", error: error.message });
  }
};

exports.getInsightHistory = async (req, res) => {
  try {
    if (!requireInsightAccess(req, res)) return;

    const period = parsePeriod(req.query.period);
    const limit = Math.min(parseInt(req.query.limit, 10) || 12, 52);
    const history = await getReportHistory(period, limit);

    res.status(200).json({ success: true, period, history });
  } catch (error) {
    console.error("[insightController] getInsightHistory:", error);
    res.status(500).json({ success: false, message: "Failed to load history", error: error.message });
  }
};

exports.generateInsight = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const period = parsePeriod(req.query.period || req.body?.period);
    const force =
      req.query.force === "true" ||
      req.body?.force === true ||
      req.body?.force === "true";

    const report = await generateInsightReport({
      period,
      generatedBy: "manual",
      force: force || true,
    });

    const plain = report.toObject ? report.toObject() : report;

    res.status(201).json({
      success: true,
      message: "Insight report regenerated with fresh data",
      regenerated: true,
      report: {
        _id: plain._id,
        period: plain.period,
        periodStart: plain.periodStart,
        periodEnd: plain.periodEnd,
        generatedAt: plain.generatedAt,
        emailDigest: plain.emailDigest,
        document: plain.document,
      },
    });
  } catch (error) {
    console.error("[insightController] generateInsight:", error);
    res.status(500).json({ success: false, message: "Failed to generate report", error: error.message });
  }
};

exports.runScheduledWeekly = async (req, res) => {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const result = await runScheduledWeeklyInsights();

    res.status(200).json({
      success: true,
      message: "Weekly insight job completed",
      reportId: result.report?._id,
      email: result.emailResult,
    });
  } catch (error) {
    console.error("[insightController] runScheduledWeekly:", error);
    res.status(500).json({ success: false, message: "Weekly job failed", error: error.message });
  }
};

exports.getAtRiskOpportunities = async (req, res) => {
  try {
    if (!requireInsightAccess(req, res)) return;

    const windows = getPeriodWindows("weekly");
    const atRisk = await computeAtRiskOpportunities(windows.periodEnd, 20);

    res.status(200).json({ success: true, atRisk });
  } catch (error) {
    console.error("[insightController] getAtRiskOpportunities:", error);
    res.status(500).json({ success: false, message: "Failed to load at-risk deals", error: error.message });
  }
};
