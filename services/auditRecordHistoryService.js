const mongoose = require("mongoose");
const Opportunity = require("../models/Opportunity");
const { getRetentionDays } = require("./auditRetentionService");

const ALLOWED_RESOURCES = new Set(["Lead", "Client", "Property", "Opportunity"]);

const retentionCutoff = () => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - getRetentionDays());
  return cutoff;
};

const buildRecordHistoryQuery = async (resource, resourceId) => {
  if (!ALLOWED_RESOURCES.has(resource)) {
    return null;
  }
  if (!mongoose.isValidObjectId(resourceId)) {
    return null;
  }

  const id = new mongoose.Types.ObjectId(resourceId);
  const idStr = String(resourceId);

  const or = [
    { resourceId: id },
    { "details.leadId": idStr },
    { "details.clientId": idStr },
    { "details.propertyId": idStr },
  ];

  if (resource === "Client") {
    const oppIds = await Opportunity.find({ client: id }).distinct("_id");
    if (oppIds.length) {
      or.push({ resource: "Opportunity", resourceId: { $in: oppIds } });
    }
  }

  if (resource === "Property") {
    const oppIds = await Opportunity.find({ property: id }).distinct("_id");
    if (oppIds.length) {
      or.push({ resource: "Opportunity", resourceId: { $in: oppIds } });
    }
  }

  return {
    $or: or,
    "details.source": { $ne: "api_middleware" },
    createdAt: { $gte: retentionCutoff() },
  };
};

const applyRoleScope = (query, userRole) => {
  if (userRole === "Manager") {
    return { ...query, userRole: { $ne: "Super Admin" } };
  }
  return query;
};

module.exports = {
  ALLOWED_RESOURCES,
  buildRecordHistoryQuery,
  applyRoleScope,
};
