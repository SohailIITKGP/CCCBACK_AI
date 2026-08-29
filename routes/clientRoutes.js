const express = require("express");
const {
  createClient,
  getAllClients,
  updateClient,
  assignClient,
  deleteClient,
  getClient,
  getClientOpportunities,
  getClientSourceLead,
  viewClient,
  punchFeFoundProperty,
  removeFeFoundProperty,
} = require("../controllers/clientController");
const authMiddleware = require("../middlewares/authMiddleware");

const router = express.Router();
router.post("/", authMiddleware, createClient);

// Get all clients
router.get("/", authMiddleware, getAllClients);

// Update client by ID
router.put("/:id", authMiddleware, updateClient);

// Assign a client to an employee
router.put("/:clientId/assign", authMiddleware, assignClient); // Assign a client to employee (based on clientId and employeeId)

// FE-Property: punch that a property option was found for this client (multiple allowed)
router.post("/:clientId/fe-found-property", authMiddleware, punchFeFoundProperty);
router.delete("/:clientId/fe-found-property/:propertyId", authMiddleware, removeFeFoundProperty);

router.get("/:clientId/preferences", authMiddleware, async (req, res) => {
  try {
    const { getClientPreferences } = require("../services/clientPreferenceMemoryService");
    const data = await getClientPreferences(req.params.clientId);
    return res.json({ success: true, ...data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/:clientId/preferences", authMiddleware, async (req, res) => {
  try {
    const { type, value, propertyId, evidence } = req.body || {};
    const { addPreferenceEntry } = require("../services/clientPreferenceMemoryService");
    const result = await addPreferenceEntry({
      clientId: req.params.clientId,
      type,
      value,
      propertyId,
      evidence,
      source: "manual",
      userId: req.user._id,
    });

    if (result.error === "invalid_input") {
      return res.status(400).json({ success: false, message: "Invalid preference type" });
    }
    if (result.error === "client_not_found") {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    return res.status(201).json({
      success: true,
      message: result.skipped ? "Preference already recorded" : "Preference saved",
      entry: result.entry,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.delete("/:clientId/preferences/:entryId", authMiddleware, async (req, res) => {
  try {
    const { deactivatePreferenceEntry } = require("../services/clientPreferenceMemoryService");
    const result = await deactivatePreferenceEntry(
      req.params.clientId,
      req.params.entryId,
      req.user._id
    );

    if (result.error === "not_found" || result.error === "entry_not_found") {
      return res.status(404).json({ success: false, message: "Preference not found" });
    }

    return res.json({ success: true, message: "Preference removed" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Link multiple properties to a client
// router.put("/link-properties", authMiddleware, linkPropertiesToClient); // New route to link properties

// Delete a client by ID
router.delete("/:id", authMiddleware, deleteClient);

// Get a specific client by ID
router.get("/client/:id/opportunities", authMiddleware, getClientOpportunities);
router.get("/client/:id/source-lead", authMiddleware, getClientSourceLead);
router.get("/client/:id", authMiddleware, getClient);

// View a specific client by ID
router.get("/:id", authMiddleware, viewClient); // View a specific client

module.exports = router;
