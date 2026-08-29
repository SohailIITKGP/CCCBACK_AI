const {
  linkPropertyToClient,
  unlinkPropertyFromClient,
} = require("../facades/linkFacade");
const { buildOverridePreview } = require("../services/propertyOverrideService");
const { OVERRIDE_REASONS } = require("../config/propertyOverride");
const Client = require("../models/Client");
const { logDataAction } = require("../utils/auditLogger");

const linkPropertyToClientHandler = async (req, res) => {
  const { clientId, propertyId, overrideReason, overrideReasonNote } = req.body;

  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized: User not found" });
    }

    const result = await linkPropertyToClient({
      clientId,
      propertyId,
      userId,
      actorMeta: { actor: "user", ipAddress: req.ip },
      overrideReason,
      overrideReasonNote,
    });

    if (result.error === "not_found") {
      return res.status(404).json({ success: false, message: result.message });
    }
    if (result.error === "property_not_approved") {
      return res.status(400).json({ success: false, message: result.message });
    }
    if (
      result.error === "override_reason_required" ||
      result.error === "override_note_required"
    ) {
      return res.status(400).json({
        success: false,
        code: result.error,
        message: result.message,
        preview: result.preview,
        overrideReasons: OVERRIDE_REASONS,
      });
    }

    logDataAction(req, {
      action: result.isOverride ? "property_override_linked" : "data_update",
      resource: "Client",
      resourceId: clientId,
      entityName: result.client?.name || "Client",
      details: {
        action: result.isOverride ? "property_override_linked" : "link_property_create_opportunity",
        propertyId: String(propertyId),
        propertyName: result.property?.name || "Property",
        opportunityId: result.opportunity?._id?.toString(),
        overrideReason: overrideReason || null,
        supersededCount: result.supersededCount || 0,
      },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: result.message,
      isOverride: result.isOverride,
      opportunity: result.opportunity,
    });
  } catch (error) {
    console.error("Error linking property to client:", error);
    res.status(500).json({ success: false, message: "Error linking property to client", error });
  }
};

const unlinkPropertyFromClientHandler = async (req, res) => {
  const { clientId, propertyId } = req.body;

  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized: User not found" });
    }

    const [client, property] = await Promise.all([
      Client.findById(clientId).select("name"),
      require("../models/propertyModel").findById(propertyId).select("name"),
    ]);

    const result = await unlinkPropertyFromClient({
      clientId,
      propertyId,
      userId,
      actorMeta: { actor: "user", ipAddress: req.ip },
    });

    if (result.error === "not_found") {
      return res.status(404).json({ success: false, message: result.message });
    }

    logDataAction(req, {
      action: "data_update",
      resource: "Client",
      resourceId: clientId,
      entityName: client?.name || "Client",
      details: {
        action: "unlink_property_from_client",
        propertyId: String(propertyId),
        propertyName: property?.name || "Property",
        hadProposalSent: result.hadProposalSent,
      },
    }).catch(() => {});

    res.status(200).json({
      success: true,
      message: result.message,
      hadProposalSent: result.hadProposalSent,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error unlinking property from client", error });
  }
};

const getOverridePreview = async (req, res) => {
  try {
    const { clientId, propertyId } = req.query;
    if (!clientId || !propertyId) {
      return res.status(400).json({ message: "clientId and propertyId are required" });
    }

    const client = await Client.findById(clientId).select("correlationId name").lean();
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    const preview = await buildOverridePreview({
      clientId,
      propertyId,
      correlationId: client.correlationId,
    });

    return res.json({
      clientId,
      propertyId,
      clientName: client.name,
      overrideReasons: OVERRIDE_REASONS,
      ...preview,
    });
  } catch (err) {
    console.error("Override preview error:", err);
    return res.status(500).json({ message: "Failed to build override preview" });
  }
};

const getClientWithProperties = async (req, res) => {
  const { clientId } = req.params;

  try {
    const userRole = req.user.role;
    const userId = req.user._id;

    const selectFields = "name contactPerson remarks state designation email contactDetails kindOfBusiness requirement minimumArea city preferredArea expectedRent priority assignedTo linkedProperties whoConverted createdAt updatedAt isVisibility";
    const selectFields2 = "remarks state kindOfBusiness requirement minimumArea city preferredArea expectedRent priority assignedTo linkedProperties whoConverted createdAt updatedAt isVisibility";
    const selectFields3 = "remarks state designation kindOfBusiness requirement minimumArea city preferredArea expectedRent priority assignedTo linkedProperties whoConverted createdAt updatedAt isVisibility";

    let clientQuery = Client.findById(clientId);

    if (["Super Admin", "Manager", "BO-Client"].includes(userRole)) {
      clientQuery = clientQuery
        .select(selectFields)
        .populate("assignedTo", "name email role")
        .populate("linkedProperties", "name city area expectedRent")
        .populate("whoConverted", "name role");
    } else if (userRole === "Product-Manager") {
      clientQuery = clientQuery
        .select(selectFields2)
        .populate("assignedTo", "name email role")
        .populate("linkedProperties", "name city area expectedRent")
        .populate("whoConverted", "name role");
    } else if (userRole === "FE-Property") {
      clientQuery = clientQuery
        .select(selectFields3)
        .populate("assignedTo", "name email role")
        .populate("linkedProperties", "name city area expectedRent")
        .populate("whoConverted", "name role");
    } else if (userRole === "Lead-Employee") {
      clientQuery = clientQuery
        .select(selectFields)
        .populate("assignedTo", "name email role")
        .populate("linkedProperties", "name city area expectedRent")
        .populate("whoConverted", "name role");
    } else {
      return res.status(403).json({ message: "Access denied" });
    }

    const client = await clientQuery;
    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    if (userRole === "Lead-Employee" && client.assignedTo?._id?.toString() !== userId.toString()) {
      return res.status(403).json({ message: "Access denied" });
    }

    res.status(200).json(client);
  } catch (error) {
    console.error("Error fetching client with properties:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const getPropertyWithClients = async (req, res) => {
  const { propertyId } = req.params;

  try {
    const Property = require("../models/propertyModel");
    const property = await Property.findById(propertyId)
      .populate("linkedClients", "name city contactDetails email")
      .populate("whoCreated", "name role");

    if (!property) {
      return res.status(404).json({ message: "Property not found" });
    }

    res.status(200).json(property);
  } catch (error) {
    console.error("Error fetching property with clients:", error);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  linkPropertyToClient: linkPropertyToClientHandler,
  unlinkPropertyFromClient: unlinkPropertyFromClientHandler,
  getOverridePreview,
  getClientWithProperties,
  getPropertyWithClients,
};
