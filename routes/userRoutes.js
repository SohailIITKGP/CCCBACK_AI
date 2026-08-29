const express = require("express");
const { addEmployee, getAllEmployees,
    getEmployeeById,
    getProfile,
    addProfilePicture,
    allemployees,
    getAllEmployeesproperty,
    updateEmployee,
 } = require("../controllers/userController");
const authMiddleware = require("../middlewares/authMiddleware");
const router = express.Router();

router.post("/add-employee",authMiddleware, addEmployee);
router.get("/employees", authMiddleware, getAllEmployees);
router.get("/employee/:id", authMiddleware, getEmployeeById);
router.put("/employee/:id", authMiddleware, updateEmployee);
router.get("/profile", authMiddleware, getProfile);
router.put("/add-profile", authMiddleware, addProfilePicture);
router.get("/employeesproperty", authMiddleware, getAllEmployeesproperty);
router.get("/allemployees", authMiddleware, allemployees);

module.exports = router;
