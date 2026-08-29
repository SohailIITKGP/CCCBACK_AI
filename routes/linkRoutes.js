const express = require('express');
const {
  linkPropertyToClient,
  unlinkPropertyFromClient,
  getClientWithProperties,
  getPropertyWithClients,
  getOverridePreview,
} = require("../controllers/linkController");
const authMiddleware = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/link-property", authMiddleware, linkPropertyToClient);
router.get("/override-preview", authMiddleware, getOverridePreview);
router.post("/unlink-property", authMiddleware, unlinkPropertyFromClient);
router.get("/client/:clientId", authMiddleware, getClientWithProperties);
router.get("/property/:propertyId", authMiddleware, getPropertyWithClients);

module.exports = router;
