const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRoles } = require("../middlewares/roleMiddleware");
const { createLimiter } = require("../middlewares/rateLimiter");
const { TODO_ROLES } = require("../utils/todoAccess");
const todoController = require("../controllers/todoController");

router.use(authMiddleware, requireRoles(...TODO_ROLES));

router.get("/summary", todoController.summary);
router.get("/dashboard", todoController.dashboard);
router.get("/calendar", todoController.calendar);
router.get("/performance", todoController.performance);
router.get("/filter-options", todoController.filterOptions);
router.get("/crm-search", todoController.crmSearch);
router.get("/", todoController.list);
router.post("/", createLimiter, todoController.create);
router.get("/:id", todoController.detail);
router.put("/:id", todoController.update);
router.put("/:id/reassign", todoController.reassign);
router.put("/:id/start", todoController.start);
router.put("/:id/complete", todoController.complete);
router.put("/:id/reopen", todoController.reopen);
router.put("/:id/cancel", todoController.cancel);
router.post("/:id/comments", todoController.comment);
router.post("/:id/attachments", todoController.attach);

module.exports = router;
