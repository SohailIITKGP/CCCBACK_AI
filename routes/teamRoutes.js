const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRoles } = require("../middlewares/roleMiddleware");
const { createLimiter } = require("../middlewares/rateLimiter");
const { TODO_ROLES } = require("../utils/todoAccess");
const teamController = require("../controllers/teamController");

router.use(authMiddleware, requireRoles(...TODO_ROLES));

router.get("/", teamController.list);
router.post("/", createLimiter, teamController.create);
router.put("/:id", teamController.update);

module.exports = router;
