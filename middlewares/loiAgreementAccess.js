const Opportunity = require("../models/Opportunity");

const LEAD_EMPLOYEE_ROLE = "Lead-Employee" ;
const SUPER_ADMIN_ROLE = "Super Admin";
const MANAGER_ROLE = "Manager";
 

function requireLeadEmployeeForLoaAgreement(req, res, next) {
  if (req.user?.role !== LEAD_EMPLOYEE_ROLE && req.user?.role !== SUPER_ADMIN_ROLE && req.user?.role !== MANAGER_ROLE  ) {
    return res.status(403).json({
      message: "Only Lead Employees can upload or edit LOI and Agreement.",
    });
  }
  return next();
}

async function requireLeadEmployeeOwnsOpportunity(req, res, next) {
  try {
    const opportunity = await Opportunity.findById(req.params.id).select(
      "whoLinkthis"
    );
    if (!opportunity) {
      return res.status(404).json({ message: "Opportunity not found" });
    }
    if (String(opportunity.whoLinkthis) !== String(req.user._id)) {
      return res.status(403).json({
        message: "You can only update LOI/Agreement on opportunities assigned to you.",
      });
    }
    return next();
  } catch (error) {
    return res.status(500).json({
      message: "Authorization check failed",
      error: error.message,
    });
  }
}

module.exports = {
  requireLeadEmployeeForLoaAgreement,
  requireLeadEmployeeOwnsOpportunity,
};
