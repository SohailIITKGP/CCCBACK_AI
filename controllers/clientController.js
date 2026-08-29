const Client = require("../models/Client");
const User = require("../models/User"); // Assuming you have User model to reference for employee
const Property = require("../models/propertyModel");
const Lead = require("../models/Lead");
const Opportunity = require("../models/Opportunity");
const mongoose = require("mongoose");
const createNotification = require("../utils/notification");
const {
  requirementFieldsChanged,
  emitRequirementsUpdated,
} = require("../facades/clientFacade");
const {
  logFieldChange,
  logDataAction,
  logTrackedFieldChanges,
} = require("../utils/auditLogger");
const {
  sanitizeClusters,
  sanitizeFormat,
  sanitizeKindOfBusiness,
} = require("../constants/businessClassification");

const ALLOWED_CLIENT_WRITE_FIELDS = [
  "name",
  "contactPerson",
  "remarks",
  "state",
  "designation",
  "contactDetails",
  "email",
  "kindOfBusiness",
  "format",
  "clusters",
  "requirement",
  "minimumArea",
  "city",
  "preferredArea",
  "expectedRent",
  "otherPreferredAreas",
  "specificRequirements",
  "priority",
  "assignedTo",
  "category",
  "height",
  "docklevelnoQty",
  "washroomQty",
  "floorStrength",
  "fireSafety",
];

function pickClientWriteFields(body = {}) {
  const picked = {};
  for (const key of ALLOWED_CLIENT_WRITE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      picked[key] = body[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(picked, "kindOfBusiness")) {
    picked.kindOfBusiness = sanitizeKindOfBusiness(picked.kindOfBusiness) || null;
  }
  if (Object.prototype.hasOwnProperty.call(picked, "format")) {
    picked.format = sanitizeFormat(picked.format) || null;
  }
  if (Object.prototype.hasOwnProperty.call(picked, "clusters")) {
    picked.clusters = sanitizeClusters(picked.clusters);
  }
  return picked;
}

function mapFeFoundPropertiesForApi(entries) {
  if (!entries || !entries.length) return [];
  return entries.map((e) => ({
    _id: e._id,
    punchedAt: e.punchedAt,
    remarks: e.remarks || "",
    property: e.property
      ? {
          _id: e.property._id,
          name: e.property.name,
          city: e.property.city,
          area: e.property.area,
          expectedRent: e.property.expectedRent,
          address: e.property.address,
        }
      : null,
    punchedBy: e.punchedBy
      ? { _id: e.punchedBy._id, name: e.punchedBy.name, role: e.punchedBy.role }
      : null,
  }));
}

// Create a new client
exports.createClient = async (req, res) => {
  const id = req.user._id;
  try {
    // Validate that assignedTo is provided
    if (!req.body.assignedTo) {
      return res.status(400).json({ 
        success: false, 
        message: "Employee assignment is required. Please assign a client to an employee." 
      });
    }

    // Validate that the assigned employee exists
    const employee = await User.findById(req.body.assignedTo);
    if (!employee) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid employee ID. Please select a valid employee." 
      });
    }

    const client = await Client.create({
      ...pickClientWriteFields(req.body),
      whoConverted: id,
    });
    
    // Update employee's assigned clients
    employee.assignedClients.push(client._id);
    await employee.save();
    
    // Create notification (non-blocking)
    createNotification("Client", "Created", client._id, client.name, id);

    logDataAction(req, {
      action: "data_create",
      resource: "Client",
      resourceId: client._id,
      entityName: client.name,
      details: { assignedTo: req.body.assignedTo },
    }).catch(() => {});

    res.status(201).json({ success: true, data: client });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getClient = async (req, res) => {
  try {
    const userRole = req.user.role;

    let clientQuery = Client.findById(req.params.id)
      .populate("assignedTo", "name email role")
      .populate("whoConverted", "name email role");

    if (["Super Admin", "Manager"].includes(userRole)) {
      clientQuery = clientQuery
        .populate("linkedProperties")
        .populate("linkedClients")
        .populate({
          path: "opportunities",
          populate: { path: "property", select: "name address city area" },
        });
    } else if (userRole === "Product-Manager") {
      clientQuery = clientQuery
        .populate("linkedProperties", "-name -contactDetails -contactPerson -owner -contact -address")
        .populate("linkedClients", "-name -email -contactDetails -contactPerson -owner -contactDetails -designation")
        .populate("opportunities", "-loaDetails -agreementDetails");
    } else if (["Lead-Employee", "BO-Client"].includes(userRole)) {
      clientQuery = clientQuery
        .populate("linkedProperties", "-name -contactDetails -contactPerson -owner -contact -address")
        .populate("linkedClients")
        .populate({
          path: "opportunities",
          select: "-loaDetails -agreementDetails",
          populate: { path: "property", select: "name city area" },
        });
    } else if (userRole === "FE-Property") {
      clientQuery = clientQuery
        .populate("linkedProperties")
        .populate("linkedClients", "-name")
        .populate({
          path: "opportunities",
          select: "-loaDetails -agreementDetails",
          populate: { path: "property", select: "name address city area" },
        });
    } else {
      return res.status(403).json({ success: false, message: "Access Denied" });
    }

    const client = await clientQuery.exec();
    if (!client) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    res.status(200).json({ success: true, data: client });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getClientOpportunities = async (req, res) => {
  try {
    const userRole = req.user.role;
    const allowed = ["Super Admin", "Manager", "BO-Client", "Lead-Employee", "Product-Manager", "FE-Property"];
    if (!allowed.includes(userRole)) {
      return res.status(403).json({ success: false, message: "Access Denied" });
    }

    const client = await Client.findById(req.params.id).select("_id assignedTo").lean();
    if (!client) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    let filter = { client: client._id, isVisibility: { $ne: false } };
    if (userRole === "Lead-Employee" || userRole === "BO-Client") {
      filter.whoLinkthis = req.user._id;
    }

    const opportunities = await Opportunity.find(filter)
      .populate("property", "name address city area expectedRent pinPointLocation owner contact")
      .populate("whoLinkthis", "name role")
      .populate("verifiedProposalBy", "name role")
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json({ success: true, data: opportunities });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getClientSourceLead = async (req, res) => {
  try {
    const userRole = req.user.role;
    const allowed = ["Super Admin", "Manager", "BO-Client", "Lead-Employee", "Product-Manager", "FE-Property"];
    if (!allowed.includes(userRole)) {
      return res.status(403).json({ success: false, message: "Access Denied" });
    }

    const client = await Client.findById(req.params.id).select("_id correlationId").lean();
    if (!client) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    let lead = await Lead.findOne({ convertedTo: client._id })
      .select(
        "name contactPerson contactNumber email designation sourceOfConnection state priority status remarks createdAt updatedAt whenassign convertedAt correlationId isConverted"
      )
      .populate("assignedTo", "name role")
      .populate("createdBy", "name role")
      .populate("whoConverted", "name role")
      .lean();

    if (!lead && client.correlationId) {
      lead = await Lead.findOne({ correlationId: client.correlationId, isConverted: true })
        .select(
          "name contactPerson contactNumber email designation sourceOfConnection state priority status remarks createdAt updatedAt whenassign convertedAt correlationId isConverted"
        )
        .populate("assignedTo", "name role")
        .populate("createdBy", "name role")
        .populate("whoConverted", "name role")
        .lean();
    }

    res.status(200).json({ success: true, data: lead });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const { queryClientsPaginated } = require("../utils/clientListPaginate");

// Get all clients (paginated + server-side search & advanced filters JSON)
exports.getAllClients = async (req, res) => {
  try {
    const formatRow = (client) => ({
      _id: client._id,
      name: client.name,
      contactPerson: client.contactPerson,
      email: client.email,
      contactDetails: client.contactDetails,
      kindOfBusiness: client.kindOfBusiness,
      remarks: client.remarks,
      state: client.state,
      designation: client.designation,
      requirement: client.requirement,
      minimumArea: client.minimumArea,
      city: client.city,
      preferredArea: client.preferredArea,
      expectedRent: client.expectedRent,
      priority: client.priority,
      assignedTo: client.assignedTo
        ? {
            _id: client.assignedTo._id,
            name: client.assignedTo.name,
            role: client.assignedTo.role,
          }
        : null,
      linkedProperties: client.linkedProperties
        ? client.linkedProperties.map((prop) => ({
            _id: prop._id,
            name: prop.name,
            city: prop.city,
            area: prop.area,
            expectedRent: prop.expectedRent,
          }))
        : [],
      whoConverted: client.whoConverted
        ? {
            _id: client.whoConverted._id,
            name: client.whoConverted.name,
            role: client.whoConverted.role,
          }
        : null,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      isVisibility: client.isVisibility,
      feFoundProperties: mapFeFoundPropertiesForApi(client.feFoundProperties),
    });

    const result = await queryClientsPaginated(req, formatRow);
    if (result.denied) {
      return res.status(403).json({ success: false, message: "Access Denied" });
    }
    res.status(200).json({
      success: true,
      data: result.data,
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
      message: `Loaded ${result.data.length} clients (page ${result.page} of ${result.totalPages})`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};


// Update client by ID
exports.updateClient = async (req, res) => {
  try {
    const existing = await Client.findById(req.params.id).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    // If assignedTo is being updated, validate it
    if (req.body.assignedTo !== undefined) {
      if (!req.body.assignedTo) {
        return res.status(400).json({ 
          success: false, 
          message: "Employee assignment is required. Please assign a client to an employee." 
        });
      }

      // Validate that the assigned employee exists
      const employee = await User.findById(req.body.assignedTo);
      if (!employee) {
        return res.status(400).json({ 
          success: false, 
          message: "Invalid employee ID. Please select a valid employee." 
        });
      }

      // Get the old client to update employee assignments
      const oldClient = existing;
      if (oldClient && oldClient.assignedTo && oldClient.assignedTo.toString() !== req.body.assignedTo) {
        // Remove from old employee's assigned clients
        const oldEmployee = await User.findById(oldClient.assignedTo);
        if (oldEmployee) {
          oldEmployee.assignedClients = oldEmployee.assignedClients.filter(
            clientId => clientId.toString() !== req.params.id
          );
          await oldEmployee.save();
        }
      }

      // Add to new employee's assigned clients
      if (!employee.assignedClients.includes(req.params.id)) {
        employee.assignedClients.push(req.params.id);
        await employee.save();
      }
    }

    const updates = pickClientWriteFields(req.body);
    const client = await Client.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!client) return res.status(404).json({ success: false, message: "Client not found" });

    if (requirementFieldsChanged(existing, updates)) {
      await emitRequirementsUpdated(client, { type: "user", userId: req.user._id }, { ipAddress: req.ip });
    }

    await createNotification("Client", "Updated", client._id, client.name);

    if (
      updates.assignedTo !== undefined &&
      String(existing.assignedTo || "") !== String(client.assignedTo || "")
    ) {
      const [oldEmp, newEmp] = await Promise.all([
        existing.assignedTo
          ? User.findById(existing.assignedTo).select("name email").lean()
          : null,
        client.assignedTo
          ? User.findById(client.assignedTo).select("name email").lean()
          : null,
      ]);
      logFieldChange(req, {
        resource: "Client",
        resourceId: client._id,
        entityName: client.name,
        field: "assignedTo",
        from: oldEmp?.name || oldEmp?.email || "Unassigned",
        to: newEmp?.name || newEmp?.email || "Unassigned",
      }).catch(() => {});
    }

    logTrackedFieldChanges(req, {
      resource: "Client",
      resourceId: client._id,
      entityName: client.name,
      previous: existing,
      next: client.toObject(),
      fields: ["name", "priority", "state", "city", "kindOfBusiness", "format"],
    }).catch(() => {});

    res.status(200).json({ success: true, data: client });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.assignClient = async (req, res) => {
  try {
    const { clientId } = req.params;  
    const { employeeId } = req.body;  

    // Validate clientId and employeeId
    if (!mongoose.Types.ObjectId.isValid(clientId)) {
      return res.status(400).json({ success: false, error: "Invalid client ID" });
    }

    if (!mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ success: false, error: "Invalid employee ID" });
    }

    // Find the employee (FE-Property)
    const employee = await User.findById(employeeId);
    if (!employee) {
      return res.status(400).json({ success: false, error: "Invalid employee or not authorized" });
    }

    // Find the client and update assignment
    const previousClient = await Client.findById(clientId).populate("assignedTo", "name email");
    if (!previousClient) {
      return res.status(404).json({ success: false, error: "Client not found" });
    }

    const client = await Client.findByIdAndUpdate(
      clientId,
      { assignedTo: employeeId },
      { new: true }
    ).populate("assignedTo", "name email");

    logFieldChange(req, {
      resource: "Client",
      resourceId: client._id,
      entityName: client.name,
      field: "assignedTo",
      from:
        previousClient.assignedTo?.name ||
        previousClient.assignedTo?.email ||
        "Unassigned",
      to: employee.name || employee.email,
      extra: { via: "assignClient" },
    }).catch(() => {});

    // If client not found
    if (!client) {
      return res.status(404).json({ success: false, error: "Client not found" });
    }

    // Update employee's assigned clients
    employee.assignedClients.push(clientId);
    await employee.save();

    // Create notification
    await createNotification("Client", "Assigned", client._id, client.name);

    // Get assigner details (who assigned the client)
    const assigner = await User.findById(req.user._id);

    await sendMailSafe({
      from: getEmailFrom(),
      to: employee.email,
      subject: "New Client Assignment Notification",
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
          <h2>New Client Assignment</h2>
          <p>Dear ${employee.name},</p>
          <p>A new client has been assigned to you by ${assigner.name} (${assigner.role}).</p>
          <p>Please log in to the system to view complete client details and take appropriate action.</p>
          <p>Thank you,<br>Rewa Realtors Team</p>
        </div>
      `,
    });

    res.status(200).json({
      success: true,
      message: "Client assigned successfully and notification sent",
      data: client,
    });
  } catch (error) {
    // Handle any unexpected errors
    res.status(500).json({ success: false, error: error.message });
  }
};


// Delete client by ID
exports.deleteClient = async (req, res) => {
  try {
    const client = await Client.findByIdAndDelete(req.params.id);
    if (!client) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }
    await createNotification("Client", "Deleted", client._id, client.name);

    logDataAction(req, {
      action: "data_delete",
      resource: "Client",
      resourceId: client._id,
      entityName: client.name,
    }).catch(() => {});

    res.status(200).json({ success: true, message: "Client deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// View a single client by ID
exports.viewClient = async (req, res) => {
  try {
    const client = await Client.findById(req.params.id).populate("assignedTo", "name email role");
    if (!client) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }
    res.status(200).json({ success: true, data: client });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * FE-Property (assigned to client) punches that they identified a property option for this client.
 * Super Admin / Manager may also record on behalf of operations.
 */
exports.punchFeFoundProperty = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { propertyId, remarks } = req.body || {};
    const userRole = req.user.role;
    const userId = req.user._id;

    if (!propertyId || !mongoose.Types.ObjectId.isValid(String(clientId)) || !mongoose.Types.ObjectId.isValid(String(propertyId))) {
      return res.status(400).json({ success: false, message: "Valid clientId and propertyId are required" });
    }

    const client = await Client.findById(clientId);
    if (!client || !client.isVisibility) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    if (userRole === "FE-Property") {
      if (!client.assignedTo || String(client.assignedTo) !== String(userId)) {
        return res.status(403).json({
          success: false,
          message: "Only the FE assigned to this client can record found properties.",
        });
      }
    } else if (!["Super Admin", "Manager"].includes(userRole)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const propertyDoc = await Property.findById(propertyId).select("_id name isVisibility isArchive");
    if (!propertyDoc) {
      return res.status(404).json({ success: false, message: "Property not found" });
    }
    if (!propertyDoc.isVisibility || propertyDoc.isArchive) {
      return res.status(400).json({ success: false, message: "Property is not available for selection" });
    }

    const dup = (client.feFoundProperties || []).some(
      (fp) => String(fp.property) === String(propertyId)
    );
    if (dup) {
      return res.status(400).json({
        success: false,
        message: "This property is already marked as a found option for this client",
      });
    }

    client.feFoundProperties = client.feFoundProperties || [];
    client.feFoundProperties.push({
      property: propertyId,
      punchedBy: userId,
      remarks: typeof remarks === "string" ? remarks.trim().slice(0, 2000) : "",
      punchedAt: new Date(),
    });
    client.updatedAt = new Date();
    await client.save();

    const propLabel = propertyDoc.name || "Property";

    logDataAction(req, {
      action: "data_update",
      resource: "Client",
      resourceId: client._id,
      entityName: client.name,
      details: {
        action: "fe_found_property",
        propertyId: String(propertyId),
        propertyName: propLabel,
        remarks: typeof remarks === "string" ? remarks.trim().slice(0, 200) : "",
      },
    }).catch(() => {});

    createNotification(
      "Client",
      "property option noted",
      client._id,
      client.name,
      userId,
      `${req.user.name} noted property option "${propLabel}" for client ${client.name}.`
    );

    const updated = await Client.findById(client._id)
      .populate({ path: "feFoundProperties.property", select: "name city area expectedRent address" })
      .populate({ path: "feFoundProperties.punchedBy", select: "name role" })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Property option recorded",
      feFoundProperties: mapFeFoundPropertiesForApi(updated.feFoundProperties),
    });
  } catch (error) {
    console.error("punchFeFoundProperty:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/** Remove a punched found-property row (FE: own punch only; Super Admin / Manager: any). */
exports.removeFeFoundProperty = async (req, res) => {
  try {
    const { clientId, propertyId } = req.params;
    const userRole = req.user.role;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(String(clientId)) || !mongoose.Types.ObjectId.isValid(String(propertyId))) {
      return res.status(400).json({ success: false, message: "Invalid id" });
    }

    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }

    const idx = (client.feFoundProperties || []).findIndex(
      (fp) => String(fp.property) === String(propertyId)
    );
    if (idx === -1) {
      return res.status(404).json({ success: false, message: "Entry not found" });
    }

    const entry = client.feFoundProperties[idx];
    if (userRole === "FE-Property") {
      if (!client.assignedTo || String(client.assignedTo) !== String(userId)) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      if (String(entry.punchedBy) !== String(userId)) {
        return res.status(403).json({ success: false, message: "You can only remove entries you created" });
      }
    } else if (!["Super Admin", "Manager"].includes(userRole)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    client.feFoundProperties.splice(idx, 1);
    client.updatedAt = new Date();
    await client.save();

    logDataAction(req, {
      action: "data_update",
      resource: "Client",
      resourceId: client._id,
      entityName: client.name,
      details: {
        action: "fe_found_property_removed",
        propertyId: String(propertyId),
      },
    }).catch(() => {});

    res.status(200).json({ success: true, message: "Removed" });
  } catch (error) {
    console.error("removeFeFoundProperty:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};
