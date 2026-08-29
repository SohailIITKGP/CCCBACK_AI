const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  createProperty,
  getAllProperties,
  getPropertyById,
  updateProperty,
  getAllPropertiesforlinkproperty,
  deleteProperty,
  updateRoadmap,
  archiveProperty,
  unarchiveProperty,
  getAllPropertiesArchive,
  submitBrokerageProperty,
  listPendingPropertySubmissions,
  approvePropertySubmission,
  rejectPropertySubmission,
} = require("../controllers/propertyController");
const  authMiddleware  = require("../middlewares/authMiddleware");

// Multer setup for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({ storage: storage });

router.post(
  "/",authMiddleware,
  upload.fields([
    { name: "propertyImages", maxCount: 6 },
    { name: "planLayouts", maxCount: 6 },
  ]),
  createProperty
);


router.get("/", authMiddleware , getAllProperties);
router.get("/pending-approval", authMiddleware, listPendingPropertySubmissions);
router.post("/brokerage/submit", authMiddleware, submitBrokerageProperty);
router.post("/:id/approve-submission", authMiddleware, approvePropertySubmission);
router.post("/:id/reject-submission", authMiddleware, rejectPropertySubmission);
router.get("/archive", authMiddleware, getAllPropertiesArchive);
router.get("/myproperty", authMiddleware , getAllPropertiesforlinkproperty);
router.get("/:id",authMiddleware, getPropertyById);
router.put(
  "/:id",authMiddleware,
  upload.fields([
    { name: "propertyImages", maxCount: 6 },
    { name: "planLayouts", maxCount: 6 },
  ]),
  updateProperty
);
router.delete("/:id", authMiddleware, deleteProperty);
router.put("/:id/roadmap", authMiddleware, updateRoadmap);
router.put("/:id/archive", authMiddleware, archiveProperty);
router.put("/:id/unarchive", authMiddleware, unarchiveProperty);
module.exports = router;
