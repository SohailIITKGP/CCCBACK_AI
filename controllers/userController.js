const User = require("../models/User");
const createNotification = require("../utils/notification");
const { logDataAction } = require("../utils/auditLogger");

const ALLOWED_ROLES = [
  "Super Admin",
  "Manager",
  "FE-Property",
  "BO-Client",
  "BO-Lead",
  "Lead-Employee",
  "Product-Manager",
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizePhone(phone) {
  return String(phone ?? "").replace(/[\s-]/g, "").trim();
}

// Super Admin and Manager can add employees
exports.addEmployee = async (req, res) => {
  try {
    const { name, email, phone, password , role } = req.body;

    // Authorization check
    if (req.user.role !== "Super Admin" && req.user.role !== "Manager") {
      return res.status(403).json({ message: "Access denied." });
    }

  
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "Email already exists." });
    }

    // Create new employee

    // const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      phone,
      password,
      role
    });

    await createNotification("Employee", "Created", user._id, user.name);

    logDataAction(req, {
      action: "data_create",
      resource: "User",
      resourceId: user._id,
      entityName: user.name,
      details: {
        action: "employee_create",
        email: user.email,
        role: user.role,
      },
    }).catch(() => {});

    res.status(201).json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};


// Fetch all employees (Only Super Admin and Manager)
exports.getAllEmployees = async (req, res) => {
  try {
    // Authorization check
    if (req.user.role !== "Super Admin" && req.user.role !== "Manager") {
      return res.status(403).json({ message: "Access denied." });
    }

    const employees = await User.find()
    .populate("assignedClients", "name email contactDetails");

    if (employees.length === 0) {
      return res.status(404).json({ success: false, message: "No employees found." });
    }

    res.status(200).json({ success: true, data: employees });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getAllEmployeesproperty = async (req, res) => {
  try {
    // Authorization check
    if (req.user.role !== "Super Admin" &&  req.user.role !== "Product-Manager" && req.user.role !== "Manager" &&  req.user.role !== "Lead-Employee" && req.user.role !== "BO-Client" && req.user.role !== "FE-Property") {
      return res.status(403).json({ message: "Access denied." });
    }

    const employees = await User.find({role: {$in: ["FE-Property", "Super Admin", "Manager", "Product-Manager"]}}).select("name role")

    if (employees.length === 0) {
      return res.status(404).json({ success: false, message: "No employees found." });
    }

    res.status(200).json({ success: true, data: employees });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.allemployees = async (req, res) => {
  try {
    const employees = await User.find().select("name role");
    res.status(200).json({ success: true, data: employees });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
// Fetch employee by ID (Only Super Admin and Manager)
exports.getEmployeeById = async (req, res) => {
  
  try {
    // Authorization check
    // if (req.user.role !== "Super Admin" && req.user.role !== "Manager") {
    //   return res.status(403).json({ message: "Access denied." });
    // }
    const id = req.params.id;
    const employee = await User.findById(id)
    .populate("assignedClients", "name email contactDetails") ; 
    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee not found."
        });
        }
        res.status(200).json({ success: true, data: employee });
        } catch (error) {
          res.status(500).json({ success: false, error: error.message });
        }
 };

//ADD PROFILE PICTURE ONLY WE GET HERE STRING
exports.addProfilePicture = async (req, res) => {
  try {
    const { profilePicture } = req.body;
    const user = await User.findById(req.user.id);
    user.profilePicture = profilePicture;
    await user.save();
    res.status(200).json({ success: true, message: "Profile picture added successfully." });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};


exports.getProfile = async (req, res) => {
          const user = await User.findById(req.user.id).populate("assignedClients");
          res.json({
            name: user.name,
            email: user.email,
            role: user.role,
            status: user.status,
            city: user.city,
            profilePicture: user.profilePicture,
            tasks: user.assignedTasks,
            clients: user.assignedClients,
          });
  };

/** Super Admin only — update name, email, phone, role, optional password */
exports.updateEmployee = async (req, res) => {
  try {
    if (req.user.role !== "Super Admin") {
      return res.status(403).json({ success: false, message: "Access denied." });
    }

    const { id } = req.params;
    const { name, email, phone, role, newPassword } = req.body;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: "Employee not found." });
    }

    const changes = {};

    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName) {
        return res.status(400).json({ success: false, message: "Name is required." });
      }
      user.name = trimmedName;
      changes.name = trimmedName;
    }

    if (email !== undefined) {
      const normalizedEmail = String(email).trim().toLowerCase();
      if (!EMAIL_REGEX.test(normalizedEmail)) {
        return res.status(400).json({ success: false, message: "Valid email is required." });
      }
      const existingUser = await User.findOne({
        email: normalizedEmail,
        _id: { $ne: id },
      });
      if (existingUser) {
        return res.status(400).json({ success: false, message: "Email already exists." });
      }
      user.email = normalizedEmail;
      changes.email = normalizedEmail;
    }

    if (phone !== undefined) {
      const normalizedPhone = normalizePhone(phone);
      if (!/^\d{10,15}$/.test(normalizedPhone)) {
        return res
          .status(400)
          .json({ success: false, message: "Phone must be 10–15 digits." });
      }
      user.phone = normalizedPhone;
      changes.phone = normalizedPhone;
    }

    if (role !== undefined) {
      if (!ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({ success: false, message: "Invalid role." });
      }
      user.role = role;
      changes.role = role;
    }

    if (newPassword !== undefined && String(newPassword).trim() !== "") {
      if (String(newPassword).length < 8) {
        return res
          .status(400)
          .json({ success: false, message: "Password must be at least 8 characters." });
      }
      user.password = newPassword;
      changes.passwordUpdated = true;
    }

    if (Object.keys(changes).length === 0) {
      return res.status(400).json({ success: false, message: "No changes provided." });
    }

    await user.save();

    await createNotification("Employee", "Updated", user._id, user.name);

    const auditChanges = { ...changes };
    delete auditChanges.passwordUpdated;

    logDataAction(req, {
      action: changes.passwordUpdated ? "password_change" : "data_update",
      resource: "User",
      resourceId: user._id,
      entityName: user.name,
      details: {
        action: "employee_update",
        targetEmail: user.email,
        ...auditChanges,
        ...(changes.passwordUpdated ? { passwordReset: true } : {}),
      },
    }).catch(() => {});

    const updated = user.toObject();
    delete updated.password;

    res.status(200).json({
      success: true,
      message: "Employee updated successfully.",
      data: updated,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};


