const Lead = require("../models/Lead");
const leadFacade = require("../facades/leadFacade");

const MAX = {
  name: 120,
  contactPerson: 120,
  contactNumber: 20,
  email: 160,
  state: 80,
  remarks: 2000,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanString(value, maxLen) {
  if (value == null) return "";
  return String(value).trim().slice(0, maxLen);
}

function isPublicFormEnabled() {
  return String(process.env.PUBLIC_LEAD_FORM_ENABLED || "true").toLowerCase() !== "false";
}

function validatePublicLeadBody(body = {}) {
  if (body._hp || body.website) {
    return { ok: false, status: 400, message: "Invalid submission" };
  }

  const name = cleanString(body.name, MAX.name);
  const email = cleanString(body.email, MAX.email).toLowerCase();
  const contactNumber = cleanString(body.contactNumber, MAX.contactNumber);

  if (!name) {
    return { ok: false, status: 400, message: "Name is required" };
  }
  if (!email || !EMAIL_RE.test(email)) {
    return { ok: false, status: 400, message: "A valid email is required" };
  }
  if (!contactNumber || contactNumber.replace(/\D/g, "").length < 10) {
    return { ok: false, status: 400, message: "A valid phone number is required" };
  }

  return {
    ok: true,
    data: {
      name,
      email,
      contactNumber,
      contactPerson: cleanString(body.contactPerson || name, MAX.contactPerson),
      state: cleanString(body.state || body.city, MAX.state),
      remarks: cleanString(body.remarks || body.requirement, MAX.remarks),
      sourceOfConnection: "public_form",
      status: "Pending",
      priority: "Medium",
    },
  };
}

async function findRecentDuplicate(email) {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  return Lead.findOne({
    email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    isConverted: false,
    createdAt: { $gte: since },
  })
    .select("_id correlationId name createdAt")
    .lean();
}

exports.submitPublicLead = async (req, res) => {
  try {
    if (!isPublicFormEnabled()) {
      return res.status(503).json({
        success: false,
        message: "Public lead form is temporarily unavailable",
      });
    }

    const validation = validatePublicLeadBody(req.body);
    if (!validation.ok) {
      return res.status(validation.status).json({
        success: false,
        message: validation.message,
      });
    }

    const duplicate = await findRecentDuplicate(validation.data.email);
    if (duplicate) {
      return res.status(200).json({
        success: true,
        message: "We already received your enquiry recently. Our team will contact you shortly.",
        duplicate: true,
        data: {
          leadId: duplicate._id,
          correlationId: duplicate.correlationId,
        },
      });
    }

    const lead = await leadFacade.createLead(
      validation.data,
      { type: "public" },
      { ipAddress: req.ip }
    );

    return res.status(201).json({
      success: true,
      message: "Thank you! We received your requirement and will contact you shortly.",
      data: {
        leadId: lead._id,
        correlationId: lead.correlationId,
        name: lead.name,
      },
    });
  } catch (error) {
    console.error("[publicLead] submit error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to submit your enquiry. Please try again later.",
    });
  }
};

exports.validatePublicLeadBody = validatePublicLeadBody;
