const Property = require("../models/propertyModel");
const User = require("../models/User");
const createNotification = require("../utils/notification");
const Client = require("../models/Client");
const Opportunity = require("../models/Opportunity");
const { queryPropertiesPaginated } = require("../utils/propertyListPaginate");
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

const ALLOWED_PROPERTY_WRITE_FIELDS = [
  "name",
  "owner",
  "contact",
  "address",
  "pinPointLocation",
  "floor",
  "area",
  "exactArea",
  "height",
  "frontageRoad",
  "expectedRent",
  "rentType",
  "roadName",
  "possession",
  "propertyImages",
  "nearestBrandImage",
  "propertySourceName",
  "shopNo",
  "lumsumRent",
  "city",
  "docklevelnoQty",
  "fireSafety",
  "washroomQty",
  "floorStrength",
  "planLayoutImage",
  "category",
  "insideViewImage",
  "brochurePdf",
  "propertyVideo",
  "clusters",
  "format",
  "brandCategory",
  "remarksForFE",
  "roadmap",
];

function pickPropertyWriteFields(body = {}) {
  const picked = {};
  for (const key of ALLOWED_PROPERTY_WRITE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      picked[key] = body[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(picked, "clusters")) {
    picked.clusters = sanitizeClusters(picked.clusters);
  }
  if (Object.prototype.hasOwnProperty.call(picked, "format")) {
    picked.format = sanitizeFormat(picked.format) || null;
  }
  if (Object.prototype.hasOwnProperty.call(picked, "brandCategory")) {
    picked.brandCategory = sanitizeKindOfBusiness(picked.brandCategory) || null;
  }
  return picked;
}

function formatPropertyListRow(property) {
  return {
    _id: property._id,
    name: property.name,
    owner: property.owner,
    contact: property.contact,
    remarks: property.remarks,
    pinPointLocation: property.pinPointLocation,
    state: property.state,
    propertySourceName: property.propertySourceName,
    shopNo: property.shopNo,
    lumsumRent: property.lumsumRent,
    docklevelnoQty: property.docklevelnoQty,
    fireSafety: property.fireSafety,
    washroomQty: property.washroomQty,
    floorStrength: property.floorStrength,
    roadName: property.roadName,
    address: property.address,
    city: property.city,
    clusters: property.clusters,
    format: property.format || "",
    brandCategory: property.brandCategory || "",
    floor: property.floor,
    height: property.height,
    frontageRoad: property.frontageRoad,
    area: property.area,
    exactArea: property.exactArea,
    expectedRent: property.expectedRent,
    rentType: property.rentType,
    possession: property.possession,
    category: property.category,
    whoCreated: property.whoCreated
      ? {
          _id: property.whoCreated._id,
          name: property.whoCreated.name,
        }
      : null,
    whoLinkthis: property.whoLinkthis
      ? {
          _id: property.whoLinkthis._id,
          name: property.whoLinkthis.name,
        }
      : null,
    createdAt: property.createdAt,
    updatedAt: property.updatedAt,
    isVisibility: property.isVisibility,
    isArchive: property.isArchive,
    propertyStatus: property.propertyStatus,
    linkedClients: property.linkedClients,
    opportunities: property.opportunities,
    propertyImages: property.propertyImages,
    nearestBrandImage: property.nearestBrandImage,
    planLayoutImage: property.planLayoutImage,
    insideViewImage: property.insideViewImage,
    brochurePdf: property.brochurePdf,
    propertyVideo: property.propertyVideo,
  };
}

exports.createProperty = async (req, res) => {
    try {
      const fields = pickPropertyWriteFields(req.body);
      const {
        name,
        owner,
        contact,
        address,
        pinPointLocation,
        floor,
        area,
        exactArea,
        height,
        frontageRoad,
        expectedRent,
        rentType,
        roadName,
        possession,
        propertyImages,
        nearestBrandImage,
        propertySourceName,
        shopNo,
        lumsumRent,
        city,
        docklevelnoQty,
        fireSafety,
        washroomQty,
        floorStrength,
        planLayoutImage,
        category,
        insideViewImage,
        brochurePdf,
        propertyVideo,
        clusters,
        format,
        brandCategory,
      } = fields;

      
      const userId = req.user?._id;
      const userRole = req.user.role;

      if (userRole === "Lead-Employee") {
        return res.status(403).json({ success: false, error: "Unauthorized access" });
      }
      console.log(req.user);
      if (!userId) {
        return res.status(401).json({ success: false, message: "Unauthorized: User ID not found" });
      }

      const property = new Property({
        name,
        owner,
        contact,
        address,
        pinPointLocation,
        floor,
        area,
        exactArea,
        height,
        frontageRoad,
        expectedRent,
        rentType,
        possession,
        propertyImages,
        nearestBrandImage,
        planLayoutImage,
        propertySourceName,
        shopNo,
        lumsumRent,
        city,
        docklevelnoQty,
        fireSafety,
        washroomQty,
        floorStrength,
        category,
        insideViewImage,
        clusters: sanitizeClusters(clusters),
        format: sanitizeFormat(format) || undefined,
        brandCategory: sanitizeKindOfBusiness(brandCategory) || undefined,
        roadName,
        brochurePdf,
        propertyVideo,
        whoCreated: userId,
        propertyStatus:
          userRole === "FE-Property" ? "draft" : "approved",
      });

      await property.save();

      // Update user's property list (non-blocking)
      User.findByIdAndUpdate(userId, { $push: { propertyCreadted: property._id } })
        .catch(error => console.error("Error updating user property list:", error));

      // Create notification (non-blocking)
      createNotification("Property", "Created", property._id, property.name, userId);

      logDataAction(req, {
        action: "data_create",
        resource: "Property",
        resourceId: property._id,
        entityName: property.name,
        details: { city: property.city, category: property.category },
      }).catch(() => {});

      res.status(201).json({ success: true, message: "Property created successfully", property });


    } catch (error) {
      console.error("Error creating property:", error);
      res.status(400).json({ success: false, message: "Error creating property", error });
    }
};

exports.getAllProperties = async (req, res) => {
  try {
    const result = await queryPropertiesPaginated(req, formatPropertyListRow, {
      isArchive: false,
    });
    if (result.denied) {
      return res.status(403).json({ success: false, error: "Unauthorized access" });
    }
    res.status(200).json({
      success: true,
      data: result.data,
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
      message: `Loaded ${result.data.length} properties (page ${result.page} of ${result.totalPages})`,
    });
  } catch (error) {
    console.error("Error fetching properties:", error);
    res.status(500).json({ success: false, error: "Server Error" });
  }
};

exports.getAllPropertiesforlinkproperty = async (req, res) => {
  try {
    const userRole = req.user.role;  
    const userId = req.user._id; 

    let properties;

    if (userRole === "Manager" || userRole === "Product-Manager" || userRole === "Super Admin" || userRole === "FE-Property" || userRole === "Lead-Employee" || userRole === "BO-Client") {
      properties = await Property.find({
        isVisibility: true,
        isArchive: false,
        propertyStatus: "approved",
      })
        .select("name _id city area expectedRent roadName")
        .sort({ createdAt: -1 });
    } 
  
    else {
      return res.status(403).json({ success: false, error: "Unauthorized access" });
    }

    res.status(200).json({ success: true, data: properties });

  } catch (error) {
    console.error("Error fetching properties:", error);
    res.status(500).json({ success: false, error: "Server Error" });
  }
};


exports.getPropertyById = async (req, res) => {
  try {
    const userRole = req.user.role;  
    const userId = req.user._id;  

    // Validate ObjectId format
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid property ID format" });
    }

    let property;

    if (userRole === "Super Admin" || userRole === "Manager") {
      // Fetch all properties for SuperAdmin and Manager
      property = await Property.findById(req.params.id)
        .populate("linkedClients")
        .populate("opportunities");
    }else if (userRole === "Product-Manager") {
      property = await Property.findById(req.params.id)
        .populate("linkedClients", "-name -email -contactDetails -contactPerson -owner -contactDetails -designation")
        .populate("opportunities", "-name -email -contactDetails -contactPerson -owner -contact -address -loaDetails -agreementDetails -createdAt -updatedAt -isVisibility -whoConverted");
    }

     else if (userRole === "FE-Property") {
       
      property = await Property.findOne({
        _id: req.params.id,
        whoCreated: userId, 
      })
        .populate("linkedClients", "city requirement minimumArea preferredArea city" );
           
      if (!property) {
        return res.status(403).json({ success: false, message: "Unauthorized access" });
      }
    } else if (userRole === "Lead-Employee" || userRole === "BO-Client") {
      property = await Property.findById(req.params.id).select("-name -owner -contact")
        .populate("linkedClients");
        
    }

    else {
      return res.status(403).json({ success: false, message: "Unauthorized access" });
    }

    if (!property) {
      return res.status(404).json({ success: false, error: "Property not found" });
    }

    res.status(200).json({ success: true, data: property });
  } catch (error) {
    console.error("Error fetching property:", error);
    res.status(500).json({ success: false, error: "Server Error" });
  }
};

// Update Property by ID
exports.updateProperty = async (req, res) => {  
  try {
    const userId = req.user?._id;
    const userRole = req.user.role; 

    if (userRole === "Lead-Employee") {
      return res.status(403).json({ success: false, error: "Unauthorized access" });
    }

    const existing = await Property.findById(req.params.id).lean();
    if (!existing) {
      return res.status(404).json({ success: false, error: "Property not found" });
    }

    const updatedData = pickPropertyWriteFields(req.body);
    updatedData.updatedAt = new Date();

    const property = await Property.findByIdAndUpdate(req.params.id, updatedData, { new: true });

    const { handlePropertyUpdated } = require("../services/propertyLifecycleService");
    await handlePropertyUpdated(existing, property.toObject(), userId).catch((err) =>
      console.error("[property] lifecycle event failed:", err.message)
    );

    await createNotification("Property", "Updated", property._id, property.name);

    logTrackedFieldChanges(req, {
      resource: "Property",
      resourceId: property._id,
      entityName: property.name,
      previous: existing,
      next: property.toObject(),
      fields: [
        "name",
        "expectedRent",
        "possession",
        "category",
        "city",
        "area",
        "owner",
        "rentType",
        "format",
        "brandCategory",
      ],
    }).catch(() => {});

    res.status(200).json({ success: true, data: property });
  } catch (error) {
    console.error("Error updating property:", error);
    res.status(500).json({ success: false, error: "Server Error" });
  }
};

exports.updateRoadmap = async (req, res) => {
  try {
    const existing = await Property.findById(req.params.id).lean();
    if (!existing) {
      return res.status(404).json({ success: false, error: "Property not found" });
    }

    const updatedData = { ...req.body };
    const property = await Property.findByIdAndUpdate(req.params.id, updatedData, { new: true });

    await createNotification("Property", "Updated", property._id, property.name);

    logDataAction(req, {
      action: "data_update",
      resource: "Property",
      resourceId: property._id,
      entityName: property.name,
      details: { via: "roadmap_update" },
    }).catch(() => {});

    res.status(200).json({ success: true, data: property });
  } catch (error) {
    console.error("Error updating roadmap:", error);
    res.status(500).json({ success: false, error: "Server Error" });
  }
}

exports.unarchiveProperty = async (req, res) => {
  const userId = req.user?._id;
  const userRole = req.user.role; 

  if (userRole === "Lead-Employee") {
    return res.status(403).json({ success: false, error: "Unauthorized access" });
  }

  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized: User ID not found" });
  }

  try {
    const property = await Property.findById(req.params.id);
    if (!property) {
      return res.status(404).json({ success: false, error: "Property not found" });
    }
    if(property.isArchive === false) {
      return res.status(400).json({ success: false, error: "Property is already unarchived" });
    }
    const updatedProperty = await Property.findByIdAndUpdate(req.params.id, { isArchive: false }, { new: true });

    logFieldChange(req, {
      resource: "Property",
      resourceId: updatedProperty._id,
      entityName: updatedProperty.name,
      field: "isArchive",
      from: "true",
      to: "false",
      extra: { via: "unarchive" },
    }).catch(() => {});

    res.status(200).json({ success: true, data: updatedProperty });
  } catch (error) {
    console.error("Error unarchiving property:", error);
    res.status(500).json({ success: false, error: "Server Error" });
  }
}

exports.archiveProperty = async (req, res) => {
  const userId = req.user?._id;
  const userRole = req.user.role; 

  if (userRole === "Lead-Employee") {
    return res.status(403).json({ success: false, error: "Unauthorized access" });
  }

  if (!userId) {
    return res.status(401).json({ success: false, message: "Unauthorized: User ID not found" });
  }

  try {
    const property = await Property.findById(req.params.id);
    if (!property) {
      return res.status(404).json({ success: false, error: "Property not found" });
    }
    if(property.isArchive === true) {
      return res.status(400).json({ success: false, error: "Property is already archived" });
    }
    const updatedProperty = await Property.findByIdAndUpdate(req.params.id, { isArchive: true }, { new: true });

    logFieldChange(req, {
      resource: "Property",
      resourceId: updatedProperty._id,
      entityName: updatedProperty.name,
      field: "isArchive",
      from: "false",
      to: "true",
      extra: { via: "archive" },
    }).catch(() => {});

    res.status(200).json({ success: true, data: updatedProperty });
  } catch (error) {
    console.error("Error archiving property:", error);
    res.status(500).json({ success: false, error: "Server Error" });
  }
}

exports.getAllPropertiesArchive = async (req, res) => {
  try {
    const result = await queryPropertiesPaginated(req, formatPropertyListRow, {
      isArchive: true,
    });
    if (result.denied) {
      return res.status(403).json({ success: false, error: "Unauthorized access" });
    }
    res.status(200).json({
      success: true,
      data: result.data,
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
      message: `Loaded ${result.data.length} archived properties (page ${result.page} of ${result.totalPages})`,
    });
  } catch (error) {
    console.error("Error fetching properties:", error);
    res.status(500).json({ success: false, error: "Server Error" });
  }
};

// Delete Property
exports.deleteProperty = async (req, res) => {
  try {
    const userId = req.user?._id;
    const userRole = req.user.role; 

    if (userRole === "Lead-Employee") {
      return res.status(403).json({ success: false, error: "Unauthorized access" });
    }

    const property = await Property.findById(req.params.id);
    if (!property) {
      return res.status(404).json({ success: false, error: "Property not found" });
    }

    // Remove property reference from linked clients
    await Client.updateMany(
      { linkedProperties: property._id },
      { $pull: { linkedProperties: property._id } }
    );

    // Delete all opportunities associated with this property
    await Opportunity.deleteMany({ property: property._id });

    const { handlePropertyDeleted } = require("../services/propertyLifecycleService");
    await handlePropertyDeleted(property, userId).catch((err) =>
      console.error("[property] delete lifecycle failed:", err.message)
    );

    // Now delete the property
    await Property.findByIdAndDelete(req.params.id);

    await createNotification("Property", "Deleted", property._id, property.name);

    logDataAction(req, {
      action: "data_delete",
      resource: "Property",
      resourceId: property._id,
      entityName: property.name,
      details: {
        linkedOpportunitiesRemoved: true,
      },
    }).catch(() => {});

    res.status(200).json({ success: true, message: "Property and related data deleted successfully" });
  } catch (error) {
    console.error("Error deleting property:", error);
    res.status(500).json({ success: false, error: "Server Error" });
  }
};

/** Brokerage / FE-Property submission — creates draft pending admin approval */
exports.submitBrokerageProperty = async (req, res) => {
  try {
    const userId = req.user?._id;
    const userRole = req.user.role;
    const allowed = ["FE-Property", "Product-Manager", "Manager", "Super Admin"];
    if (!allowed.includes(userRole)) {
      return res.status(403).json({ success: false, error: "Unauthorized access" });
    }
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const property = new Property({
      ...pickPropertyWriteFields(req.body),
      whoCreated: userId,
      propertyStatus: "draft",
      isVisibility: false,
      submissionNote:
        typeof req.body.submissionNote === "string"
          ? req.body.submissionNote.slice(0, 2000)
          : "",
    });
    await property.save();

    await createNotification("Property", "Submitted", property._id, property.name, userId);
    return res.status(201).json({
      success: true,
      message: "Property submitted for approval",
      property,
    });
  } catch (error) {
    console.error("[property] brokerage submit failed:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

exports.listPendingPropertySubmissions = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!["Manager", "Super Admin"].includes(userRole)) {
      return res.status(403).json({ success: false, error: "Unauthorized access" });
    }

    const pending = await Property.find({ propertyStatus: "draft" })
      .sort({ createdAt: -1 })
      .populate("whoCreated", "name email role")
      .lean();

    return res.status(200).json({ success: true, count: pending.length, data: pending });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.approvePropertySubmission = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!["Manager", "Super Admin"].includes(userRole)) {
      return res.status(403).json({ success: false, error: "Unauthorized access" });
    }

    const property = await Property.findById(req.params.id);
    if (!property) {
      return res.status(404).json({ success: false, message: "Property not found" });
    }
    if (property.propertyStatus !== "draft") {
      return res.status(400).json({ success: false, message: "Property is not pending approval" });
    }

    property.propertyStatus = "approved";
    property.isVisibility = true;
    property.reviewedBy = req.user._id;
    property.reviewedAt = new Date();
    property.rejectionReason = null;
    await property.save();

    await createNotification("Property", "Approved", property._id, property.name, req.user._id);
    return res.status(200).json({ success: true, message: "Property approved", property });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.rejectPropertySubmission = async (req, res) => {
  try {
    const userRole = req.user.role;
    if (!["Manager", "Super Admin"].includes(userRole)) {
      return res.status(403).json({ success: false, error: "Unauthorized access" });
    }

    const property = await Property.findById(req.params.id);
    if (!property) {
      return res.status(404).json({ success: false, message: "Property not found" });
    }
    if (property.propertyStatus !== "draft") {
      return res.status(400).json({ success: false, message: "Property is not pending approval" });
    }

    property.propertyStatus = "closed";
    property.isVisibility = false;
    property.rejectionReason = req.body?.reason || "Rejected by reviewer";
    property.reviewedBy = req.user._id;
    property.reviewedAt = new Date();
    await property.save();

    return res.status(200).json({ success: true, message: "Property submission rejected", property });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
