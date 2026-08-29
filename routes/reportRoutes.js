const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");

const {
    getTagReports,
    getLeadGenerationReport,
    leadToOpportunityReport,
    generateBrandwiseReport,
    generateCityWiseReport,
    getFePropertyReport,
    generateEmployeePerformanceReport,
    generateSummaryReport,
    getTatReport,
    getTatSiteVisitExport,
    getTatIndividualReport,
    getAdminDashboardFunnel,
    getAvailableBrands
} = require("../controllers/reportController");

router.get("/tag-reports", authMiddleware, getTagReports);
router.get("/lead-generation-report", authMiddleware, getLeadGenerationReport);
router.get("/lead-to-opportunity-report", authMiddleware, leadToOpportunityReport);
router.get("/brand-wise-report", authMiddleware, generateBrandwiseReport);
router.get("/available-brands", authMiddleware, getAvailableBrands);
router.get("/city-wise-report/:city", authMiddleware, generateCityWiseReport);
router.get("/fe-property-report", authMiddleware, getFePropertyReport);
router.get("/summary-report", authMiddleware, generateSummaryReport);
router.get("/myreport", authMiddleware, generateEmployeePerformanceReport);
router.get("/tat-report", authMiddleware, getTatReport);
router.get("/tat-site-visit-export", authMiddleware, getTatSiteVisitExport);
router.get("/tat-individual-report", authMiddleware, getTatIndividualReport);
router.get("/admin-dashboard-funnel", authMiddleware, getAdminDashboardFunnel);
module.exports = router;

