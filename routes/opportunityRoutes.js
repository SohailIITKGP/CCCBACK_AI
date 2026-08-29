const express = require("express");
const router = express.Router();
const axios = require('axios');
const Opportunity = require("../models/Opportunity");
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const Property = require("../models/propertyModel");
const PDFDocument = require('pdfkit');
const fs = require('fs');
// const PDFDocument = require('pdfkit');
const { createWriteStream } = require('fs');
const moment = require("moment"); 
const cron = require('node-cron');
const path = require('path');
const { sendMailSafe, getEmailFrom } = require("../utils/smtpTransporter");
const User = require("../models/User");
const oppController = require("../controllers/oppController");
const  authMiddleware  = require("../middlewares/authMiddleware");
const { requireRoles, WRITE_ROLES, ADMIN_ROLES } = require("../middlewares/roleMiddleware");
const mongoose = require('mongoose');
const { queryOpportunitiesList } = require("../utils/opportunityListPaginate");
const { queryPipelineOpportunitiesList } = require("../utils/opportunityPipelineList");
const {
  buildReminderStateForStatus,
  fireImmediateReminderIfDue,
  isReminderTrackedStatus,
} = require("../services/opportunityReminderService");
const { logFieldChange, logDataAction } = require("../utils/auditLogger");

const oppDisplayName = (opportunity) => {
  const client = opportunity.client?.name || "Client";
  const property = opportunity.property?.name || "Property";
  return `${client} – ${property}`;
};

const logOpportunityEvent = (req, opportunity, details, logAction = "data_update") =>
  logDataAction(req, {
    action: logAction,
    resource: "Opportunity",
    resourceId: opportunity._id,
    entityName: oppDisplayName(opportunity),
    details,
  }).catch(() => {});

const logOpportunityStageUpdate = (req, opportunity, { stage, via, previousStatus }) => {
  const details = {
    action: "opportunity_stage_update",
    stage,
    via,
  };
  if (previousStatus !== stage) {
    details.changeType = "field_change";
    details.field = "status";
    details.from = previousStatus;
    details.to = stage;
  }
  return logOpportunityEvent(req, opportunity, details);
};

const {
  requireLeadEmployeeForLoaAgreement,
  requireLeadEmployeeOwnsOpportunity,
} = require("../middlewares/loiAgreementAccess");

//post load details
router.post(
  "/:id/loaadd",
  authMiddleware,
  requireLeadEmployeeForLoaAgreement,
  requireLeadEmployeeOwnsOpportunity,
  async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;

  const { dateOfLOI, lockinPeriod, startDate, endDate, image } = req.body;

  try {
    const opportunity = await Opportunity.findById(id)
      .populate("client", "name")
      .populate("property", "name");

    if (!opportunity) {
      return res.status(404).json({ message: "Opportunity not found" });
    }

    const previousStatus = opportunity.status;
    opportunity.loaDetails = { dateOfLOI, lockinPeriod, startDate, endDate, image, whenCreated: Date.now() , whoCreated: userId };
    opportunity.status = "LOI"; // Move status to LOI stage

    await opportunity.save();
    logOpportunityStageUpdate(req, opportunity, {
      stage: "LOI",
      via: "loa_create",
      previousStatus,
    });
    res.status(200).json({ message: "LOA details updated successfully", opportunity });
  } catch (error) {
    res.status(500).json({ message: "Error updating LOA details", error });
  }
});


// Update LOA Details
router.put(
  "/:id/loa",
  authMiddleware,
  requireLeadEmployeeForLoaAgreement,
  requireLeadEmployeeOwnsOpportunity,
  async (req, res) => {
  const { id } = req.params;
  const { dateOfLOI, lockinPeriod, startDate, endDate, image } = req.body;

  try {
    const opportunity = await Opportunity.findById(id)
      .populate("client", "name")
      .populate("property", "name");

    if (!opportunity) {
      return res.status(404).json({ message: "Opportunity not found" });
    }

    const previousStatus = opportunity.status;
    // Update LOA details
    opportunity.loaDetails = { dateOfLOI, lockinPeriod, startDate, endDate, image };
    opportunity.status = "LOI"; // Move status to LOI stage

    await opportunity.save();
    logOpportunityStageUpdate(req, opportunity, {
      stage: "LOI",
      via: "loa_update",
      previousStatus,
    });
    res.status(200).json({ message: "LOA details updated successfully", opportunity });
  } catch (error) {
    res.status(500).json({ message: "Error updating LOA details", error });
  }
});


// post agreement details
router.post(
  "/:id/agreementadd",
  authMiddleware,
  requireLeadEmployeeForLoaAgreement,
  requireLeadEmployeeOwnsOpportunity,
  async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;

  const { date, rental, image } = req.body;

  try {
    const opportunity = await Opportunity.findById(id)
      .populate("client", "name")
      .populate("property", "name");

    if (!opportunity) {
      return res.status(404).json({ message: "Opportunity not found" });
    }

    const previousStatus = opportunity.status;
    opportunity.agreementDetails = { date, rental, image, whenCreated: Date.now() , whoCreated: userId };
    opportunity.status = "Agreement"; // Move status to Agreement stage

    await opportunity.save();
    logOpportunityStageUpdate(req, opportunity, {
      stage: "Agreement",
      via: "agreement_create",
      previousStatus,
    });
    res.status(200).json({ message: "Agreement details updated successfully", opportunity });
  } catch (error) {
    res.status(500).json({ message: "Error updating Agreement details", error });
  }
});

// Update Agreement Details
router.put(
  "/:id/agreement",
  authMiddleware,
  requireLeadEmployeeForLoaAgreement,
  requireLeadEmployeeOwnsOpportunity,
  async (req, res) => {
  const { id } = req.params;
  const { date, rental, image } = req.body;

  try {
    const opportunity = await Opportunity.findById(id)
      .populate("client", "name")
      .populate("property", "name");

    if (!opportunity) {
      return res.status(404).json({ message: "Opportunity not found" });
    }

    const previousStatus = opportunity.status;
    // Update Agreement details
    opportunity.agreementDetails = { date, rental, image };
    opportunity.status = "Agreement"; // Move status to Agreement stage

    await opportunity.save();
    logOpportunityStageUpdate(req, opportunity, {
      stage: "Agreement",
      via: "agreement_update",
      previousStatus,
    });
    res.status(200).json({ message: "Agreement details updated successfully", opportunity });
  } catch (error) {
    res.status(500).json({ message: "Error updating Agreement details", error });
  }
});

// Get All Opportunities (paginated; query: page, limit, sortBy, sortOrder, q, filters JSON)
router.get("/", authMiddleware, async (req, res) => {
  try {
    const result = await queryOpportunitiesList(req);
    if (result.denied) {
      return res.status(403).json({ success: false, message: "Unauthorized access" });
    }
    res.status(200).json({
      success: true,
      data: result.data,
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
      message: `Loaded ${result.data.length} opportunities (page ${result.page} of ${result.totalPages})`,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching opportunities",
      error: error.message,
    });
  }
});

// Get pipeline opportunities (post–site-visit stages); query: startDate, endDate, page, limit, q, filters JSON
router.get("/pipeline", authMiddleware, async (req, res) => {
  try {
    const result = await queryPipelineOpportunitiesList(req);
    if (result.denied) {
      return res.status(403).json({ success: false, message: "Unauthorized access" });
    }
    res.status(200).json({
      success: true,
      data: result.data,
      page: result.page,
      limit: result.limit,
      total: result.total,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
      message: `Loaded ${result.data.length} pipeline opportunities (page ${result.page} of ${result.totalPages})`,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching opportunities",
      error: error.message,
    });
  }
});

// router.get("/visible", authMiddleware, async (req, res) => {
//   try {
//     const role = req.user.role;
//     if (role !== "Super Admin" && role !== "Manager" && role !== "BO-Client" && role !== "Lead-Employee" && role !== "Product-Manager") {
//       return res.status(403).json({ message: "Unauthorized access" });
//     }
//     const opportunities = await Opportunity.find({ isVisibility: false })
//       .populate("client")
//       .populate("property");
//     if (role === "Product-Manager") {
//       opportunities.select("-propertyImages -insideViewImage -brochurePdf -planLayoutImage")
//       .populate({
//         path: "client",
//         select: "-name -email -contactDetails -contactPerson -owner -contactDetails -designation",
//       });
//     } else if (role === "BO-Client" || role === "Lead-Employee") {
//       opportunities.select("-propertyImages -insideViewImage -brochurePdf -planLayoutImage")
//       .populate({
//         path: "client",
//       });
//     } else if (role === "Super Admin" || role === "Manager") {
//       opportunities.select()
//       .populate({
//         path: "client",
//       });


//     }
//     else {
//       return res.status(403).json({ message: "Unauthorized access" });
//     }
//     res.status(200).json(opportunities);
//   } catch (error) {
//     res.status(500).json({ message: "Error fetching opportunities", error });
//   }
// });
router.get("/visible", authMiddleware, async (req, res) => {
  try {
    const role = req.user.role;
    const userId = req.user._id;
    
    if (role !== "Super Admin" && role !== "Manager" && role !== "BO-Client" && role !== "Lead-Employee" && role !== "Product-Manager") {
      return res.status(403).json({ message: "Unauthorized access" });
    }

    let opportunitiesQuery = Opportunity.find({ isVisibility: false })
      .select("-propertyImages -insideViewImage -brochurePdf -planLayoutImage")
      .populate("client")
      .populate({
        path: "whoLinkthis",
        select: "name role",
      })
      .populate({
        path: "verifiedProposalBy",
        select: "name role",
      })
      .populate({
        path: "commentsSection.whoCommented",
        select: "name",
      })
      .populate({
        path: "proposalEmailSentBy",
        select: "name role",
      })
      .sort({ createdAt: -1 });

    // Apply role-based restrictions similar to main route
    if (role === "BO-Client") {
      opportunitiesQuery = opportunitiesQuery.select(" -propertyImages -insideViewImage -brochurePdf -planLayoutImage").populate({
        path: "property",
        select: " -propertyImages -insideViewImage -brochurePdf -planLayoutImage -address -contact -owner",
      });
    } else if (role === "Lead-Employee") {
      opportunitiesQuery = opportunitiesQuery.find({ whoLinkthis: userId }).select(" -propertyImages -insideViewImage -brochurePdf -planLayoutImage").populate({
        path: "property",
        select: " -propertyImages -insideViewImage -brochurePdf -planLayoutImage -address -contact -owner",
      });
    } else if (role === "Product-Manager") {
      opportunitiesQuery = opportunitiesQuery.select("-propertyImages -insideViewImage -brochurePdf -planLayoutImage").populate({
        path: "property",
        select: " -propertyImages -insideViewImage -brochurePdf -planLayoutImage -address -contact -owner",
      }).populate({
        path: "client",
        select: "-name -email -contactDetails -contactPerson -owner -contactDetails -designation",
      });
    } else {
      opportunitiesQuery = opportunitiesQuery.populate("property");
    }

    const opportunities = await opportunitiesQuery;
    res.status(200).json(opportunities);
  } catch (error) {
    res.status(500).json({ message: "Error fetching opportunities", error });
  }
});



router.get("/:id", authMiddleware, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid opportunity id" });
    }

    const opportunity = await Opportunity.findById(req.params.id)
      .populate("client")
      .populate("property")
      .populate("commentsSection.whoCommented", "name email role");
    if (!opportunity) {
      return res.status(404).json({ message: "Opportunity not found" });
    }

    // Lead-Employee / BO-Client only see opportunities they own or commented on.
    const role = req.user.role;
    if (role === "Lead-Employee" || role === "BO-Client") {
      const userId = req.user._id.toString();
      const ownerId = opportunity.whoLinkthis?.toString();
      const commented = (opportunity.commentsSection || []).some(
        (c) => c.whoCommented && c.whoCommented.toString() === userId
      );
      if (ownerId !== userId && !commented) {
        return res.status(403).json({ message: "Forbidden" });
      }
    }

    res.status(200).json(opportunity);
  } catch (error) {
    res.status(500).json({ message: "Error fetching opportunity", error: error.message });
  }
});

router.put("/:id/follow-ups", authMiddleware, requireRoles(...WRITE_ROLES), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid opportunity id" });
    }
    const { followUps } = req.body;

    // Validate input
    if (!followUps || !Array.isArray(followUps) || followUps.length === 0) {
      return res.status(400).json({ message: "Follow-ups are required" });
    }

    // Get the last follow-up status
    const lastFollowUp = followUps[followUps.length - 1]; // Take the last item
    const isRejected = lastFollowUp.status === "Reject";

    const existing = await Opportunity.findById(req.params.id)
      .populate("client", "name")
      .populate("property", "name");
    if (!existing) {
      return res.status(404).json({ message: "Opportunity not found" });
    }
    const previousStatus = existing.status;

    // Update opportunity
    const opportunity = await Opportunity.findByIdAndUpdate(
      req.params.id,
      {
        $set: { followUps: followUps, status: lastFollowUp.status, isVisibility: !isRejected },
      },
      { new: true }
    )
      .populate("client", "name")
      .populate("property", "name");

    logOpportunityEvent(req, opportunity, {
      action: "opportunity_follow_ups_update",
      followUpCount: followUps.length,
      ...(previousStatus !== lastFollowUp.status && {
        changeType: "field_change",
        field: "status",
        from: previousStatus,
        to: lastFollowUp.status,
      }),
    });

    res.status(200).json(opportunity); // Return updated opportunity
  } catch (error) {
    console.error("Error updating follow-ups:", error);
    res.status(500).json({ message: "Error updating follow-ups" });
  }
});

router.delete("/:id/delete", authMiddleware, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid opportunity id" });
    }
    const opportunity = await Opportunity.findById(req.params.id)
      .populate("client", "name")
      .populate("property", "name");
    if (!opportunity) {
      return res.status(404).json({ message: "Opportunity not found" });
    }

    const entityName = oppDisplayName(opportunity);
    const clientId = opportunity.client?._id || opportunity.client;
    const propertyId = opportunity.property?._id || opportunity.property;

    // Remove opportunity reference from client
    await Client.findByIdAndUpdate(clientId, {
      $pull: {
        opportunities: opportunity._id,
        linkedProperties: propertyId,
      },
    });

    // Remove opportunity reference from property
    await Property.findByIdAndUpdate(propertyId, {
      $pull: {
        opportunities: opportunity._id,
        linkedClients: clientId,
      },
    });

    // Delete the opportunity
    await Opportunity.findByIdAndDelete(req.params.id);

    logOpportunityEvent(
      req,
      opportunity,
      {
        action: "opportunity_delete",
        clientName: opportunity.client?.name,
        propertyName: opportunity.property?.name,
      },
      "data_delete"
    );

    res.status(200).json({ message: "Opportunity deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Error deleting opportunity", error });
  }
});

router.get("/pdf/:oppId", authMiddleware, async (req, res) => {
  const opportunityId = req.params.oppId;
  if (!mongoose.isValidObjectId(opportunityId)) {
    return res.status(400).send("Invalid opportunity id");
  }

  try {
    // Fetch opportunity data from MongoDB
    const opportunity = await Opportunity.findById(opportunityId)
      .populate("client")
      .populate("property");

    if (!opportunity) {
      return res.status(404).send("Opportunity not found");
    }

    // Create PDF document with mobile-friendly settings
    const doc = new PDFDocument({
      margin: 30,
      size: [595.28, 841.89], // A4 size for better compatibility
      bufferPages: true
    });
    
    const fileName = `proposal-${opportunity.client.name}-${Date.now()}.pdf`;
    const filePath = `./public/pdfs/${fileName}`;

    // Ensure directory exists
    if (!fs.existsSync("./public/pdfs")) {
      fs.mkdirSync("./public/pdfs", { recursive: true });
    }

    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Helper function for responsive text sizing
    const responsiveText = (text, x, y, options = {}) => {
      const defaultOptions = {
        width: doc.page.width - 80,
        align: 'left'
      };
      return doc.text(text, x, y, {...defaultOptions, ...options});
    };

    // Page 1: Cover Page
    doc.rect(0, 0, doc.page.width, doc.page.height).fill("white");
    
    try {
      
      const logoPath = path.resolve(__dirname, '../public/images/logo.png');
      doc.image(logoPath, {
        fit: [500, 500], 
        align: 'center',
        valign: 'center'
      });
      console.log("Logo loaded from:", logoPath);
    } catch (error) {
      console.error("Error loading logo:", error);
      console.log("Logo path not found. Please ensure logo exists at the correct path.");
      // Add text instead of image when logo can't be found
      doc.fillColor("#FFFFFF").fontSize(16).text("Company Logo", {
        align: "center"
      });
    }
    doc.moveDown(32);
    doc.fillColor("black").fontSize(36).font("Helvetica-Bold").text("PROPOSAL FOR", {
      align: "center"
    });
    
    doc.moveDown(1);
    doc.fillColor("#FFC107").fontSize(42).font("Helvetica-Bold").text(opportunity.client.name, {
      align: "center"
    });
    
    doc.moveDown(2);

    // Add footer with date and company information
    doc.fillColor("#002147").fontSize(14).font("Helvetica-Bold").text("PROPOSAL DATE", {
      align: "center"
    });
    
    doc.moveDown(0.5);
    const currentDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    doc.fillColor("#000000").fontSize(12).font("Helvetica").text(currentDate, {
      align: "center"
    });
    
    doc.moveDown(2);
    
    // Add footer image that takes full width of the page
    try {
      const footerImagePath = path.resolve(__dirname, '../public/images/footer.PNG');
 
      const footerHeight = 100;  
      
       
      doc.image(footerImagePath, 0, doc.page.height - footerHeight, {
        width: doc.page.width,
        height: footerHeight,
      });
      console.log("Footer image loaded from:", footerImagePath);
    } catch (error) {
      console.error("Error loading footer image:", error);
     
      const footerHeight = 100;  
      const footerY = doc.page.height - footerHeight;
      doc.rect(0, footerY, doc.page.width, footerHeight).fill("#002147");
      doc.fillColor("#FFFFFF").fontSize(12).text("REWA REALTORS", 0, footerY + 20, {
        align: "center",
        width: doc.page.width
      });
      doc.fillColor("#FFFFFF").fontSize(10).text("www.Rewaaltors.com", 0, footerY + 40, {
        align: "center",
        width: doc.page.width
      });
    }
   

    // Page 2: Proposed Location
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 80).fill("#002147");
    doc.fillColor("#FFFFFF").fontSize(28).font("Helvetica-Bold").text("PROPOSED LOCATION", 30, 30, {
      align: "center"
    });
    
    doc.moveDown(3);
    doc.fillColor("#000000").fontSize(16).font("Helvetica");
    
    // Address with proper formatting
    const address = opportunity.property.address || "Address not available";
    responsiveText(address, 50, 120, { align: 'center' });
    
    doc.moveDown(1);
    
    // Google Map Link
    if (opportunity.property.pinPointLocation) {
      doc.fillColor("#0000FF").fontSize(14).text("View on Google Maps", {
        align: 'center',
        link: opportunity.property.pinPointLocation,
        underline: true
      });
    }
    
    // Try to add a map image if available (best-effort – PDF still generates without it)
    const MAP_FETCH_OPTS = { responseType: "arraybuffer", timeout: 8000 };
    const addMapPlaceholder = (label = "Map unavailable") => {
      doc.moveDown(2);
      doc.rect(50, doc.y, 500, 350).stroke();
      doc.text(label, { align: "center" });
    };

    try {
      if (opportunity.property.pinPointLocation) {
        let mapAdded = false;

        // Try Google Maps first
        if (process.env.GOOGLE_MAPS_API_KEY) {
          try {
            const googleMapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${encodeURIComponent(address)}&zoom=15&size=600x400&markers=color:red|${encodeURIComponent(address)}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
            const mapResponse = await axios.get(googleMapUrl, MAP_FETCH_OPTS);
            const mapBuffer = Buffer.from(mapResponse.data, "binary");
            doc.moveDown(2);
            doc.image(mapBuffer, { fit: [500, 350], align: "center" });
            mapAdded = true;
          } catch (googleError) {
            console.warn("[pdf] Google static map failed:", googleError.message);
          }
        }

        if (!mapAdded) {
          try {
            const location = opportunity.property.pinPointLocation.split("@")[1] || address;
            const geoapifyKey = process.env.GEOAPIFY_API_KEY;
            if (geoapifyKey) {
              const geoapifyUrl = `https://maps.geoapify.com/v1/staticmap?style=osm-carto&width=600&height=400&center=${encodeURIComponent(location)}&zoom=15&marker=${encodeURIComponent(location)};color:%23ff0000;size:large&apiKey=${geoapifyKey}`;
              const geoapifyResponse = await axios.get(geoapifyUrl, MAP_FETCH_OPTS);
              const geoapifyBuffer = Buffer.from(geoapifyResponse.data, "binary");
              doc.moveDown(2);
              doc.image(geoapifyBuffer, { fit: [500, 350], align: "center" });
              mapAdded = true;
            }
          } catch (geoapifyError) {
            console.warn("[pdf] Geoapify static map failed:", geoapifyError.message);
          }
        }

        if (!mapAdded) {
          console.warn("[pdf] No map image available – using placeholder");
          addMapPlaceholder("Map location (unavailable)");
        }
      } else {
        addMapPlaceholder("No map location data available");
      }
    } catch (error) {
      console.warn("[pdf] Map section skipped:", error.message);
      addMapPlaceholder("Map location (error loading map)");
    }

    // Page 3: Commercial Details
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 80).fill("#002147");
    doc.fillColor("#FFFFFF").fontSize(28).font("Helvetica-Bold").text("COMMERCIAL DETAILS", 30, 30, {
      align: "center"
    });
    
    doc.moveDown(4);
    
    // Create a table for commercial details
    const tableTop = 120;
    const tableLeft = 50;
    const tableWidth = 500;
    const rowHeight = 40;
    const colWidth = tableWidth / 2;
    
    // Table headers
    doc.fillColor("#002147").rect(tableLeft, tableTop, tableWidth, rowHeight).fill();
    doc.fillColor("#FFFFFF").fontSize(14).font("Helvetica-Bold").text("PROPERTY DETAILS", tableLeft + 10, tableTop + 12);
    doc.text("SPECIFICATIONS", tableLeft + colWidth + 10, tableTop + 12);
    
    // Table rows
    let currentTop = tableTop + rowHeight;
    
    // Helper function for table rows
    const addTableRow = (label, value) => {
      doc.fillColor("#F5F5F5").rect(tableLeft, currentTop, tableWidth, rowHeight).fill();
      doc.fillColor("#000000").fontSize(12).font("Helvetica-Bold").text(label, tableLeft + 10, currentTop + 12);
      doc.font("Helvetica").text(value || "N/A", tableLeft + colWidth + 10, currentTop + 12);
      currentTop += rowHeight;
    };
    
    addTableRow("PROPERTY PREMISES NAME", opportunity.property.name || opportunity.property.propertyName);
    addTableRow("LOCATION ADDRESS", opportunity.property.address);
    addTableRow("PROPOSED FLOOR", opportunity.property.floor);
    addTableRow("CARPET AREA", opportunity.property.exactArea);
    addTableRow("FRONTAGE", opportunity.property.frontageRoad);
    addTableRow("SHOP HEIGHT", opportunity.property.height);
    addTableRow("POSSESSION", opportunity.property.possession);
    addTableRow("RENT", opportunity.property.expectedRent);
    
    // Page 4+: Property Images
    const images = opportunity.property.propertyImages;
    const imageUrls = Object.values(images).filter(url => url);
    
    if (imageUrls.length > 0) {
      doc.addPage();
      doc.rect(0, 0, doc.page.width, 80).fill("#002147");
      doc.fillColor("#FFFFFF").fontSize(28).font("Helvetica-Bold").text("PROPERTY IMAGES", 30, 30, {
        align: "center"
      });
      
      // Display images in a grid (2 per row)
      let yPosition = 120;
      let xPosition = 50;
      const imageWidth = 240;
      const imageHeight = 180;
      const imagesPerRow = 2;
      
      for (let i = 0; i < imageUrls.length; i++) {
        // Add a new page if needed
        if (yPosition > 650) {
          doc.addPage();
          doc.rect(0, 0, doc.page.width, 80).fill("#002147");
          doc.fillColor("#FFFFFF").fontSize(28).font("Helvetica-Bold").text("PROPERTY IMAGES", 30, 30, {
            align: "center"
          });
          yPosition = 120;
        }
        
        try {
          const response = await axios.get(imageUrls[i], { responseType: "arraybuffer" });
          const imageBuffer = Buffer.from(response.data, "binary");
          
          // Calculate position
          const currentX = xPosition + (i % imagesPerRow) * (imageWidth + 15);
          
          doc.image(imageBuffer, currentX, yPosition, {
            fit: [imageWidth, imageHeight],
            align: 'center'
          });
          
          // Move to next row if needed
          if ((i + 1) % imagesPerRow === 0) {
            yPosition += imageHeight + 30;
          }
        } catch (error) {
          console.error(`Error loading image: ${imageUrls[i]}`, error);
        }
      }
    }
    
    // About Us Page
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 80).fill("#002147");
    doc.fillColor("#FFFFFF").fontSize(28).font("Helvetica-Bold").text("ABOUT US", 30, 30, {
      align: "center"
    });
    
    doc.moveDown(4);
    doc.fillColor("#000000").fontSize(14).font("Helvetica").text(
      "Rewa Realtors is a trusted name in the world of real estate. We are a leading commercial real estate company with over 21 years of experience in the industry. At Rewa Realtors, we understand that commercial real estate is not just about buying and selling properties, it's about building long-lasting relationships with our clients.",
      50, 120, { align: 'justify', width: 500 }
    );
    
    doc.moveDown(1);
    doc.text(
      "Our team of experts brings unparalleled knowledge and expertise to every project, ensuring that we deliver exceptional results every time. We specialize in providing customized solutions to meet the unique needs of our clients, whether it's finding the perfect office space or negotiating a lease agreement.",
      { align: 'justify', width: 500 }
    );
    
    doc.moveDown(1);
    doc.text(
      "We take pride in our commitment to transparency and ethical business practices. Our goal is to ensure that every client has a positive experience with us, from start to finish. We believe that our success is measured by the success of our clients, and we work tirelessly to ensure that they achieve their goals.",
      { align: 'justify', width: 500 }
    );
    
    doc.moveDown(1);
    doc.text(
      "For more details please visit our website: www.Rewaaltors.com",
      { align: 'justify', width: 500 }
    );
    
    doc.moveDown(2);
    doc.fontSize(18).font("Helvetica-Bold").text("Thank you", { align: 'center' });
    
    /////////////////////////////////// Contact Page ///////////////////////////////////


    doc.addPage();
    doc.rect(0, 0, doc.page.width, 80).fill("#002147");
    doc.fillColor("#FFFFFF").fontSize(28).font("Helvetica-Bold").text("CONTACT US", 30, 30, {
      align: "center"
    });

    // try {
      
    //   const logoPath = path.resolve(__dirname, '../public/images/logo.png');
    //   doc.image(logoPath, {
    //     fit: [300, 300], 
    //     align: 'center',
    //     valign: 'center'
    //   });
    //   console.log("Logo loaded from:", logoPath);
    // } catch (error) {
    //   console.error("Error loading logo:", error);
    //   console.log("Logo path not found. Please ensure logo exists at the correct path.");
    //   // Add text instead of image when logo can't be found
    //   doc.fillColor("#FFFFFF").fontSize(16).text("Company Logo", {
    //     align: "center"
    //   });
    // }

    
    doc.moveDown(12);
    doc.fillColor("#000000").fontSize(14).font("Helvetica-Bold").text("Address:", 50, 120);
    doc.font("Helvetica").text("405, SANGIN ASPIRE, NEAR RTO, PAL SURAT – GUJARAT", 120, 120);
    
    doc.moveDown(1);
    doc.font("Helvetica-Bold").text("Website:", 50, doc.y);
    doc.font("Helvetica").fillColor("#0000FF").text("www.Rewaaltors.com", 120, doc.y - 14, {
      link: "http://www.Rewaaltors.com",
      underline: true
    });
    
    doc.moveDown(1);
    doc.fillColor("#000000").font("Helvetica-Bold").text("Email:", 50, doc.y);
    doc.font("Helvetica").fillColor("#0000FF").text("mehul@Rewaaltors.com", 120, doc.y - 14, {
      link: "mailto:mehul@Rewaaltors.com",
      underline: true
    });
    
    doc.moveDown(1);
    doc.fillColor("#000000").font("Helvetica-Bold").text("Contact numbers:", 50, doc.y);
    doc.font("Helvetica").text("+91 97277 29812  -  +91 96646 53165  -  +91 63519 99374", 170, doc.y - 14);

    doc.moveDown(1);

    doc.moveDown(1);
    
    // Position the image at the bottom of the page with proper height and full width
    try {
      const socialPath = path.resolve(__dirname, '../public/images/5.png');
      const imageHeight = 200; 
      const l = 50;
    
      doc.image(socialPath, 0, doc.page.height - imageHeight, {
        width: doc.page.width,
        height: imageHeight
      });
      
      console.log("Social media footer image loaded from:", socialPath);
    } catch (error) {
      console.error("Error loading social media image:", error);
      
      const imageHeight = 100;
      
      doc.rect(0, doc.page.height - imageHeight, doc.page.width, imageHeight).fill("#f5f5f5");
      doc.fillColor("#666666").fontSize(12).text("Follow us on social media", 0, doc.page.height - imageHeight/2 - 6, {
        align: "center",
        width: doc.page.width
      });
    }
    // Add page numbers
    let pageCount = doc.bufferedPageCount;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      if (i > 0) { // Skip page number on cover page
        doc.fillColor("#666666").fontSize(10).text(
          `Page ${i + 1} of ${pageCount}`,
          50,
          doc.page.height - 50,
          { align: "center", width: doc.page.width - 100 }
        );
      }
    }
    
    doc.end();

    // Send PDF as response
    stream.on("finish", () => {
      res.download(filePath, fileName, (err) => {
        if (err) {
          console.error("Error sending file:", err);
          res.status(500).send("Error sending file");
        }
        // Clean up file after sending
        setTimeout(() => {
          try {
            fs.unlinkSync(filePath);
          } catch (err) {
            console.error("Error deleting temporary file:", err);
          }
        }, 60000); // Delete after 1 minute
      });
    });

  } catch (err) {
    console.error("Error generating PDF:", err);
    res.status(500).send("Internal Server Error");
  }
});

router.put("/updatestatus/:id", authMiddleware, requireRoles(...WRITE_ROLES), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ message: "Invalid opportunity id" });
  }
  if (!status || typeof status !== "string") {
    return res.status(400).json({ message: "Status is required" });
  }

  try {
    const opportunity = await Opportunity.findById(id)
      .populate('client')
      .populate('property');

    if (!opportunity) {
      return res.status(404).json({ message: "Opportunity not found" });
    }

    const previousStatus = opportunity.status;
    opportunity.status = status;

    // Reset reminder cadence whenever status actually changes.
    if (previousStatus !== status) {
      opportunity.reminderState = buildReminderStateForStatus(status);
    }

    if (status === "Win") {
      // Start a session for transaction
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // 1. Update the winning opportunity
        opportunity.isVisibility = false;
        await opportunity.save({ session });

        // 2. Get all opportunity IDs from client and property
        const clientOpportunityIds = opportunity.client.opportunities || [];
        const propertyOpportunityIds = opportunity.property.opportunities || [];

        // 3. Combine and deduplicate opportunity IDs, excluding the winning one
        const otherOpportunityIds = [...new Set([
          ...clientOpportunityIds,
          ...propertyOpportunityIds
        ])].filter(oppId => oppId.toString() !== opportunity._id.toString());

        // 4. Update client to only keep winning property and opportunity
        await Client.findByIdAndUpdate(
          opportunity.client._id,
          {
            $set: { 
              linkedProperties: [opportunity.property._id],
              opportunities: [opportunity._id],
              isVisibility: false 
            }
          },
          { session }
        );

        // 5. Update property to only keep winning client and opportunity
        await Property.findByIdAndUpdate(
          opportunity.property._id,
          {
            $set: { 
              linkedClients: [opportunity.client._id],
              opportunities: [opportunity._id],
              isVisibility: false
            }
          },
          { session }
        );

        // 6. Delete all other opportunities
        if (otherOpportunityIds.length > 0) {
          await Opportunity.deleteMany({
            _id: { $in: otherOpportunityIds }
          }).session(session);
        }

        // 7. Update all other properties to remove this client and their opportunities
        await Property.updateMany(
          { 
            _id: { $ne: opportunity.property._id },
            linkedClients: opportunity.client._id 
          },
          {
            $pull: {
              linkedClients: opportunity.client._id,
              opportunities: { $in: otherOpportunityIds }
            }
          },
          { session }
        );

        // Commit the transaction
        await session.commitTransaction();
        session.endSession();

        const { recordOutcomeFromOpportunity } = require("../services/outcomeTrackingService");
        recordOutcomeFromOpportunity(opportunity, status).catch((err) =>
          console.error("[opportunityRoutes] outcome tracking failed:", err.message)
        );

        const { regenerateReminderScheduleTasks } = require("../services/followUpTaskService");
        regenerateReminderScheduleTasks(opportunity).catch((err) =>
          console.error("[opportunityRoutes] Win status reminder cleanup failed:", err.message)
        );

        if (previousStatus !== status) {
          logFieldChange(req, {
            resource: "Opportunity",
            resourceId: opportunity._id,
            entityName: oppDisplayName(opportunity),
            field: "status",
            from: previousStatus,
            to: status,
            extra: { via: "updatestatus", outcome: "Win" },
          }).catch(() => {});
        }

        res.json({
          message: "Opportunity status updated successfully and other opportunities cleaned up",
          deletedOpportunities: otherOpportunityIds.length
        });
      } catch (error) {
        // If an error occurs, abort the transaction
        await session.abortTransaction();
        session.endSession();
        throw error;
      }
    } else {
      await opportunity.save();
      if (previousStatus !== status) {
        const { regenerateReminderScheduleTasks } = require("../services/followUpTaskService");
        regenerateReminderScheduleTasks(opportunity).catch((err) =>
          console.error("[opportunityRoutes] reminder task schedule failed:", err.message)
        );

        const {
          recordOutcomeFromOpportunity,
          isTerminalOpportunityStatus,
        } = require("../services/outcomeTrackingService");
        if (isTerminalOpportunityStatus(status)) {
          recordOutcomeFromOpportunity(opportunity, status, {
            lossReason: req.body.lossReason || req.body.comment || null,
          }).catch((err) =>
            console.error("[opportunityRoutes] outcome tracking failed:", err.message)
          );
        }
        logFieldChange(req, {
          resource: "Opportunity",
          resourceId: opportunity._id,
          entityName: oppDisplayName(opportunity),
          field: "status",
          from: previousStatus,
          to: status,
          extra: { via: "updatestatus" },
        }).catch(() => {});
      }
      res.json({ message: "Opportunity status updated successfully" });
    }
  } catch (error) {
    res.status(500).json({ message: "Error updating opportunity status", error });
  }
});

router.post("/opportunity/:id/comment", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;  
    const userId = req.user._id;
    const { tag, comment, sitevisit, followup, sitevisitfollowup } = req.body;

    const opportunity = await Opportunity.findById(id)
      .populate("client", "name email phone")
      .populate({
        path: "property",
        select: "name address owner contact whoCreated",
        populate: {
          path: "whoCreated",
          select: "email"
        }
      })
      .populate({
        path: "whoLinkthis",
        select: "name email"
      });

    if (!opportunity) {
      return res.status(404).json({ error: "Opportunity not found" });
    }

    // Get user details who is making the comment
    const user = await User.findById(userId).select("name email role");

    // Create the comment object
    const newComment = {
      tag: tag,
      comment,
      sitevisit: sitevisit || { date: null, notification: false },
      followup: followup || { date: null, notification: false },
      whoCommented: userId,
    };

    // Add the comment to the commentsSection array
    opportunity.commentsSection.push(newComment);
    const previousStatus = opportunity.status;
    opportunity.status = tag;

    // Reset reminder cadence whenever status changes via a new comment.
    // (Re-applying the same tag also resets the cadence intentionally – the
    // user is signalling renewed activity on that stage.)
    const statusChanged = previousStatus !== tag;
    if (statusChanged || !opportunity.reminderState || opportunity.reminderState.status !== tag) {
      opportunity.reminderState = buildReminderStateForStatus(tag);
    }

    // If tag is Reject, set isVisibility to false and unlink client and opportunity
    if (tag === "Reject") {
      opportunity.isVisibility = false;
      
      // Unlink client and opportunity
      if (opportunity.client && opportunity.property) {
        await Property.findByIdAndUpdate(
          opportunity.property._id,
          { 
            $pull: { 
              linkedClients: opportunity.client._id,
              opportunities: opportunity._id
            } 
          }
        );
        
        // Also update the client to remove property and opportunity references
        await Client.findByIdAndUpdate(
          opportunity.client._id,
          { 
            $pull: { 
              linkedProperties: opportunity.property._id,
              opportunities: opportunity._id
            } 
          }
        );
      }
    }
    
    // Save the opportunity
    await opportunity.save();

    const entityName = oppDisplayName(opportunity);
    const commentDetails = {
      action: "opportunity_comment",
      tag: tag || "",
      statusChanged,
    };

    if (statusChanged) {
      commentDetails.previousStatus = previousStatus;
      commentDetails.newStatus = tag;
    }

    if (comment && String(comment).trim()) {
      commentDetails.commentPreview = String(comment).trim().slice(0, 200);
    }
    if (followup?.date) commentDetails.followUpDate = followup.date;
    if (sitevisit?.date) commentDetails.siteVisitDate = sitevisit.date;

    if (statusChanged) {
      commentDetails.changeType = "field_change";
      commentDetails.field = "status";
      commentDetails.from = previousStatus;
      commentDetails.to = tag;
    }

    logDataAction(req, {
      action: "data_update",
      resource: "Opportunity",
      resourceId: opportunity._id,
      entityName,
      details: commentDetails,
    }).catch(() => {});

    // Pre-create full reminder schedule tasks (e.g. 7d → +5d → +5d).
    if (isReminderTrackedStatus(tag)) {
      const { regenerateReminderScheduleTasks } = require("../services/followUpTaskService");
      regenerateReminderScheduleTasks(opportunity).catch((err) =>
        console.error("[opportunityRoutes] reminder task schedule failed:", err.message)
      );
    }

    // Create employee tasks for scheduled follow-up / site visit dates.
    const savedComment = opportunity.commentsSection[opportunity.commentsSection.length - 1];
    if (savedComment) {
      const { createScheduledTask } = require("../services/followUpTaskService");
      const taskPromises = [];
      if (followup && followup.date) {
        taskPromises.push(
          createScheduledTask({
            opportunity,
            commentId: savedComment._id,
            taskType: "follow_up",
            dueDate: followup.date,
            assignedTo: userId,
          })
        );
      }
      if (sitevisit && sitevisit.date) {
        taskPromises.push(
          createScheduledTask({
            opportunity,
            commentId: savedComment._id,
            taskType: "site_visit",
            dueDate: sitevisit.date,
            assignedTo: userId,
          })
        );
      }
      Promise.allSettled(taskPromises).catch((err) =>
        console.error("[opportunityRoutes] follow-up task creation failed:", err.message)
      );
    }

    // For same-day reminders (e.g. "Site Visit Done") fire immediately
    // instead of waiting for the next cron sweep. Failures here are logged
    // but never block the user response.
    if (isReminderTrackedStatus(tag)) {
      fireImmediateReminderIfDue(opportunity._id).catch((err) =>
        console.error("[opportunityRoutes] immediate reminder failed:", err.message)
      );
    }

    // Email notifications (best-effort – comment save must not fail on SMTP issues)
    try {
    // Prepare notification details
    let notificationDetails = [];
    
    // Check for site visit
    if (sitevisit && sitevisit.date) {
      notificationDetails.push({
        type: "Site Visit",
        date: new Date(sitevisit.date).toLocaleString()
      });
    }
    
    // Check for follow-up
    if (followup && followup.date) {
      notificationDetails.push({
        type: "Follow-up",
        date: new Date(followup.date).toLocaleString()
      });
    }
    
    // Handle notifications based on tag type and scheduled events
    if (["Approved", "Win", "Reject"].includes(tag)) {
      // For these specific tags, only notify Super Admins
      const superAdmins = await User.find({
        role: "Super Admin"
      }).select("email name");

      if (superAdmins.length > 0) {
        let emailSubject = "";
        let emailContent = "";

        // Customize email content based on tag
        if (tag === "Approved") {
          emailSubject = "New Agreement Added to Opportunity";
          emailContent = `
            <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
              <h2>New Agreement Added</h2>
              <p>Dear Admin,</p>
              <p>A new agreement has been added by ${user.name} (${user.role}).</p>
              <p>Please review and approve the agreement.</p>
              <h3>Opportunity Details:</h3>
              <ul>
                <li><strong>Client:</strong> ${opportunity.client.name} (${opportunity.client.phone})</li>
                <li><strong>Property:</strong> ${opportunity.property.name}, ${opportunity.property.address}</li>
                <li><strong>Owner:</strong> ${opportunity.property.owner}</li>
                <li><strong>Contact:</strong> ${opportunity.property.contact}</li>
                <li><strong>Comment:</strong> ${comment || 'No comment provided'}</li>
              </ul>`;
              
          // Add scheduled events if any
          if (notificationDetails.length > 0) {
            emailContent += `<h3>Scheduled Events:</h3><ul>`;
            notificationDetails.forEach(detail => {
              emailContent += `<li><strong>${detail.type}:</strong> ${detail.date}</li>`;
            });
            emailContent += `</ul>`;
          }
              
          emailContent += `
              <p>Please log in to the system for more details and to take appropriate action.</p>
              <p>Thank you,<br>Rewa Realtors Team</p>
            </div>
          `;
        } else if (tag === "Win") {
          emailSubject = "Opportunity Won! 🎉";
          emailContent = `
            <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
              <h2>Opportunity Successfully Closed!</h2>
              <p>Dear Admin,</p>
              <p>Great news! An opportunity has been successfully closed by ${user.name} (${user.role}).</p>
              <h3>Opportunity Details:</h3>
              <ul>
                <li><strong>Client:</strong> ${opportunity.client.name} (${opportunity.client.phone})</li>
                <li><strong>Property:</strong> ${opportunity.property.name}, ${opportunity.property.address}</li>
                <li><strong>Owner:</strong> ${opportunity.property.owner}</li>
                <li><strong>Contact:</strong> ${opportunity.property.contact}</li>
                <li><strong>Comment:</strong> ${comment || 'No comment provided'}</li>
              </ul>`;
              
          // Add scheduled events if any
          if (notificationDetails.length > 0) {
            emailContent += `<h3>Scheduled Events:</h3><ul>`;
            notificationDetails.forEach(detail => {
              emailContent += `<li><strong>${detail.type}:</strong> ${detail.date}</li>`;
            });
            emailContent += `</ul>`;
          }
              
          emailContent += `
              <p>Congratulations to the team!</p>
              <p>Thank you,<br>Rewa Realtors Team</p>
            </div>
          `;
        } else if (tag === "Reject") {
          emailSubject = "Opportunity Lost";
          emailContent = `
            <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
              <h2>Opportunity Lost</h2>
              <p>Dear Admin,</p>
              <p>An opportunity has been marked as lost by ${user.name} (${user.role}).</p>
              <h3>Opportunity Details:</h3>
              <ul>
                <li><strong>Client:</strong> ${opportunity.client.name} (${opportunity.client.phone})</li>
                <li><strong>Property:</strong> ${opportunity.property.name}, ${opportunity.property.address}</li>
                <li><strong>Owner:</strong> ${opportunity.property.owner}</li>
                <li><strong>Contact:</strong> ${opportunity.property.contact}</li>
                <li><strong>Reason for Loss:</strong> ${comment || 'No reason provided'}</li>
              </ul>`;
              
          // Add scheduled events if any
          if (notificationDetails.length > 0) {
            emailContent += `<h3>Scheduled Events:</h3><ul>`;
            notificationDetails.forEach(detail => {
              emailContent += `<li><strong>${detail.type}:</strong> ${detail.date}</li>`;
            });
            emailContent += `</ul>`;
          }
              
          emailContent += `
              <p>Please review the details to identify potential areas for improvement in our sales process.</p>
              <p>Thank you,<br>Rewa Realtors Team</p>
            </div>
          `;
        }

        // Send email to all super admins
        for (const admin of superAdmins) {
          const mailOptions = {
            from: '"Rewa Realtors" <info@Rewaaltors.com>',
            to: admin.email,
            subject: emailSubject,
            html: emailContent,
            attachments: notificationDetails.length > 0 ? [{
              filename: `${tag.toLowerCase()}-${Date.now()}.ics`,
              content: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Rewa Realtors//Opportunity Management//EN
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VEVENT
DTSTART:${new Date(notificationDetails[0].date).toISOString().replace(/-|:|\.\d+/g, '').slice(0, 15) + 'Z' || 'date not specified' }
DTEND:${new Date(notificationDetails[0].date).toISOString().replace(/-|:|\.\d+/g, '').slice(0, 15) + 'Z' || 'date not specified'}
DTSTAMP:${new Date().toISOString().replace(/-|:|\.\d+/g, '').slice(0, 15) + 'Z' || 'date not specified'}
UID:${Date.now()}@Rewaaltors.com
ORGANIZER;CN=Rewa Realtors:mailto:info@Rewaaltors.com
SUMMARY:${tag} - ${opportunity.client.name}
DESCRIPTION:${tag} for opportunity with client ${opportunity.client.name} and property ${opportunity.property.name}. Comment: ${comment || 'No comment provided'}
LOCATION:${opportunity.property.address || 'Location not specified'}
STATUS:CONFIRMED
SEQUENCE:0
END:VEVENT
END:VCALENDAR`,
              contentType: 'text/calendar; method=REQUEST'
            }] : []
          };

          await sendMailSafe({
            from: getEmailFrom(),
            ...mailOptions,
          });
        }
      }
    } 
    
    // Handle notifications for other tags or when site visit/follow-up is scheduled
    if (notificationDetails.length > 0 ) {
      // Find all managers and super admins
      const admins = await User.find({
        role: { $in: ["Manager", "Super Admin"] }
      }).select("email name");

      // Also get the property creator
      const propertyCreator = await User.findById(opportunity.property.whoCreated).select("email name");

      // Combine admins and property creator
      const recipients = [...admins];
      if (propertyCreator) {
        recipients.push(propertyCreator);
      }

      if (recipients.length > 0) {
        // Prepare email subject and content
        let emailSubject = "";
        let emailContent = "";
        
        if (notificationDetails.length > 0) {
          // If there are scheduled events
          emailSubject = `New Events Scheduled for Opportunity`;
          emailContent = `
            <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
              <h2>New Events Scheduled</h2>
              <p>Dear Admin,</p>
              <p>New events have been scheduled by ${user.name} (${user.role}).</p>
              <h3>Opportunity Details:</h3>
              <ul>
                <li><strong>Client:</strong> ${opportunity.client.name} (${opportunity.client.phone})</li>
                <li><strong>Property:</strong> ${opportunity.property.name}, ${opportunity.property.address}</li>
                <li><strong>Owner:</strong> ${opportunity.property.owner}</li>
                <li><strong>Contact:</strong> ${opportunity.property.contact}</li>
                <li><strong>Property Created By:</strong> ${opportunity.property.whoCreated?.name || 'Not specified'}</li>
                <li><strong>Status:</strong> ${tag}</li>
                <li><strong>Comment:</strong> ${comment || 'No comment provided'}</li>
              </ul>
              <h3>Scheduled Events:</h3>
              <ul>`;
              
          // Process all notification details and send emails
          const emailPromises = notificationDetails.map(async (detail) => {
            // Add event details to email content
            emailContent += `<li><strong>${detail.type}:</strong> ${detail.date}</li>`;
            
            // Create .ics file for Google Calendar integration
            const eventStartTime = new Date(detail.date);
            const eventEndTime = new Date(eventStartTime);
            eventEndTime.setHours(eventEndTime.getHours() + 1); // Default 1 hour duration
            
            // Format dates for iCalendar format (YYYYMMDDTHHMMSSZ)
            const formatDate = (date) => {
              return date.toISOString().replace(/-|:|\.\d+/g, '').slice(0, 15) + 'Z';
            };
            
            const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Rewa Realtors//Opportunity Management//EN
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VEVENT
DTSTART:${formatDate(eventStartTime)}
DTEND:${formatDate(eventEndTime)}
DTSTAMP:${formatDate(new Date())}
UID:${Date.now()}@Rewaaltors.com
ORGANIZER;CN=Rewa Realtors:mailto:info@Rewaaltors.com
SUMMARY:${detail.type} - ${opportunity.client.name}
DESCRIPTION:${detail.type} for opportunity with client ${opportunity.client.name} and property ${opportunity.property.name}. Comment: ${comment || 'No comment provided'}
LOCATION:${opportunity.property.address || 'Location not specified'}
STATUS:CONFIRMED
SEQUENCE:0
END:VEVENT
END:VCALENDAR`;
            
            // Create a temporary file path for the .ics file
            const icsFileName = `${detail.type.replace(/\s+/g, '-')}-${Date.now()}.ics`;
            const icsFilePath = `./public/calendar/${icsFileName}`;
            
            // Ensure directory exists
            if (!fs.existsSync("./public/calendar")) {
              fs.mkdirSync("./public/calendar", { recursive: true });
            }
            
            // Write the .ics file
            fs.writeFileSync(icsFilePath, icsContent);
            
            return {
              icsContent,
              icsFileName,
              icsFilePath
            };
          });

          // Wait for all ICS files to be created
          const icsFiles = await Promise.all(emailPromises);

          // Send emails to all recipients
          for (const recipient of recipients) {
            const mailOptions = {
              from: '"Rewa Realtors" <info@Rewaaltors.com>',
              to: recipient.email,
              subject: emailSubject,
              html: emailContent,
              attachments: icsFiles.map(file => ({
                filename: file.icsFileName,
                content: file.icsContent,
                contentType: 'text/calendar; method=REQUEST'
              }))
            };

            await sendMailSafe({
            from: getEmailFrom(),
            ...mailOptions,
          });
          }

          // Clean up temporary ICS files
          icsFiles.forEach(file => {
            setTimeout(() => {
              try {
                fs.unlinkSync(file.icsFilePath);
              } catch (err) {
                console.error("Error deleting temporary ICS file:", err);
              }
            }, 60000); // Delete after 1 minute
          });

          emailContent += `
              </ul>
              <p>Please log in to the system for more details.</p>
              <p>Thank you,<br>Rewa Realtors Team</p>
            </div>
          `;
          } 
          else if (!["Approved", "Win", "Reject"].includes(tag)) {
          // If only status changed (no scheduled events)
          emailSubject = `Opportunity Status Updated to ${tag}`;
          emailContent = `
            <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px;">
              <h2>Opportunity Status Updated</h2>
              <p>Dear Admin,</p>
              <p>An opportunity status has been updated by ${user.name} (${user.role}).</p>
              <h3>Opportunity Details:</h3>
              <ul>
                <li><strong>Client:</strong> ${opportunity.client.name} (${opportunity.client.phone})</li>
                <li><strong>Property:</strong> ${opportunity.property.name}, ${opportunity.property.address}</li>
                <li><strong>Owner:</strong> ${opportunity.property.owner}</li>
                <li><strong>Contact:</strong> ${opportunity.property.contact}</li>
                <li><strong>Property Created By:</strong> ${opportunity.property.whoCreated?.name || 'Not specified'}</li>
                <li><strong>New Status:</strong> ${tag}</li>
                <li><strong>Comment:</strong> ${comment || 'No comment provided'}</li>
              </ul>
              <p>Please log in to the system for more details.</p>
              <p>Thank you,<br>Rewa Realtors Team</p>
            </div>
          `;
        }

        // Send email to all recipients
        for (const recipient of recipients) {
          const mailOptions = {
            from: '"Rewa Realtors" <info@Rewaaltors.com>',
            to: recipient.email,
            subject: emailSubject,
            html: emailContent,
            attachments: notificationDetails.length > 0 ? [{
              filename: `${tag.toLowerCase()}-${Date.now()}.ics`,
              content: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Rewa Realtors//Opportunity Management//EN
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VEVENT
DTSTART:${new Date(notificationDetails[0].date).toISOString().replace(/-|:|\.\d+/g, '').slice(0, 15) + 'Z' || 'date not specified' }
DTEND:${new Date(notificationDetails[0].date).toISOString().replace(/-|:|\.\d+/g, '').slice(0, 15) + 'Z' || 'date not specified'}
DTSTAMP:${new Date().toISOString().replace(/-|:|\.\d+/g, '').slice(0, 15) + 'Z' || 'date not specified'}
UID:${Date.now()}@Rewaaltors.com
ORGANIZER;CN=Rewa Realtors:mailto:info@Rewaaltors.com
SUMMARY:${tag} - ${opportunity.client.name}
DESCRIPTION:${tag} for opportunity with client ${opportunity.client.name} and property ${opportunity.property.name}. Comment: ${comment || 'No comment provided'}
LOCATION:${opportunity.property.address || 'Location not specified'}
STATUS:CONFIRMED
SEQUENCE:0
END:VEVENT
END:VCALENDAR`,
              contentType: 'text/calendar; method=REQUEST'
            }] : []
          };

          await sendMailSafe({
            from: getEmailFrom(),
            ...mailOptions,
          });
        }
      }
    }
    } catch (emailErr) {
      console.error("[opportunityRoutes] comment notification email failed:", emailErr.message);
    }

    res.status(200).json({ message: "Comment added successfully", opportunity });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "An error occurred while adding the comment" });
  }
});
 
router.get("/lol/count", authMiddleware, requireRoles(...ADMIN_ROLES), async (req, res) => {
  try {
    const { range, year, month } = req.query;

    // Set default date range filters
    let startDate, endDate;

    if (range === "today") {
      startDate = moment().startOf("day").toDate();
      endDate = moment().endOf("day").toDate();
    } else if (range === "this_week") {
      startDate = moment().startOf("week").toDate();
      endDate = moment().endOf("week").toDate();
    } else if (range === "this_month") {
      startDate = moment().startOf("month").toDate();
      endDate = moment().endOf("month").toDate();
    } else if (year && month) {
      startDate = moment(`${year}-${month}-01`).startOf("month").toDate();
      endDate = moment(`${year}-${month}-01`).endOf("month").toDate();
    } else if (year) {
      startDate = moment(`${year}-01-01`).startOf("year").toDate();
      endDate = moment(`${year}-12-31`).endOf("year").toDate();
    }

    // Query for the specified range (using `convertedAt` for the leads)
    const query = {};
    if (startDate && endDate) {
      query.createdAt = { $gte: startDate, $lte: endDate }; // Query for leads created within the range
    }

    // Filter for converted leads within the date range (by `convertedAt`)
    const convertedQuery = {};
    if (startDate && endDate) {
      convertedQuery.convertedAt = { $gte: startDate, $lte: endDate }; // Query for leads converted within the range
    }

    // Fetch data for the range
    const opportunities = await Opportunity.find(query);
    const leads = await Lead.find(query);
    const convertedLeads = await Lead.find(convertedQuery); // Get converted leads within the date range

    // Fetch total data till date (no date filter)
    const totalOpportunities = await Opportunity.countDocuments({});
    const totalwonopp = await Opportunity.countDocuments({ status: "Win" });
    const totalLossopp = await Opportunity.countDocuments({ status: "Reject" });
    const totalLeads = await Lead.countDocuments({});
    const totalLeadConverted = await Lead.countDocuments({ isConverted: true });

    // Filtered data
    const opportunitiesActive = opportunities.filter(op => op.isVisibility === true);
    const opportunitiesInactive = opportunities.filter(op => op.isVisibility === false);
    const opportunitiesWin = opportunities.filter(op => op.status === "Win");
    const opportunitiesLoss = opportunities.filter(op => op.status === "Reject");

    // Response
    res.status(200).json({
      totalOpportunitiesTillDate: totalOpportunities,
      totalLeadsTillDate: totalLeads,
      totalwonoppTillDate: totalwonopp,
      totalLossoppTillDate: totalLossopp,
      totalLeadConvertedTillDate: totalLeadConverted,
      filtered: {
        totalOpportunities: opportunities.length,
        activeOpportunities: opportunitiesActive.length,
        inactiveOpportunities: opportunitiesInactive.length,
        winOpportunities: opportunitiesWin.length,
        lossOpportunities: opportunitiesLoss.length,
        totalLeads: leads.length,
        totalLeadConverted: convertedLeads.length, // Include the number of converted leads in the response
      },
    });
  } catch (error) {
    console.error("Error fetching opportunities count:", error);
    res.status(500).json({ message: "Error fetching opportunities count", error });
  }
});

// Get all follow-up and site visit dates for the calendar
router.get("/calendar-events", authMiddleware, async (req, res) => {
  const userId = req.user._id;
  const role = req.user.role;
  console.log("Calendar events request from:", userId, role);
  try {
    let query = { isVisibility: true };
    
    // Filter opportunities based on user role
    if (role === "BO-Client" || role === "Lead-Employee") {
      // For BO-Client or Lead-Employee, only show events where they are the commenter
      query = {
        isVisibility: true,
        "commentsSection.whoCommented": userId
      };
    }
    
    const opportunities = await Opportunity.find(query)
      .populate("client", "name")
      .populate("property", "name")
      .lean();  

    console.log(`Found ${opportunities.length} opportunities matching query`);
    const events = [];

    for (const opportunity of opportunities) {
      if (!opportunity.commentsSection || opportunity.commentsSection.length === 0) {
        console.log(`Opportunity ${opportunity._id} has no comments, skipping`);
        continue;
      }

      for (const comment of opportunity.commentsSection) {
        if (!comment) {
          console.log("Found null comment, skipping");
          continue;
        }
        
        // For BO-Client or Lead-Employee, only include their own comments
        if ((role === "BO-Client" || role === "Lead-Employee")) {
          if (!comment.whoCommented) {
            console.log("Comment has no whoCommented field, skipping");
            continue;
          }
          
          const commentUserId = comment.whoCommented.toString();
          const currentUserId = userId.toString();
          
          if (commentUserId !== currentUserId) {
            console.log(`Comment user ${commentUserId} doesn't match current user ${currentUserId}, skipping`);
            continue;
          }
        }

        const clientName = opportunity.client?.name || "Client";
        const propertyName = opportunity.property?.name || "Property";

        // Handle follow-up date
        if (comment.followup && comment.followup.date) {
          const followupDate = new Date(comment.followup.date);
          if (!isNaN(followupDate.getTime())) {  // Check if date is valid
            events.push({
              title: `Follow-up: ${clientName} - ${propertyName}`,
              date: followupDate,
              type: "Follow-Up",
              opportunityId: opportunity._id.toString(),
              commentId: comment._id ? comment._id.toString() : null
            });
          } else {
            console.log(`Invalid followup date for comment in opportunity ${opportunity._id}`);
          }
        }

        // Handle site visit date  
        if (comment.sitevisit && comment.sitevisit.date) {
          const sitevisitDate = new Date(comment.sitevisit.date);
          if (!isNaN(sitevisitDate.getTime())) {  // Check if date is valid
            events.push({
              title: `Site Visit: ${clientName} - ${propertyName}`,
              date: sitevisitDate,
              type: "Site Visit",
              opportunityId: opportunity._id.toString(),
              commentId: comment._id ? comment._id.toString() : null
            });
          } else {
            console.log(`Invalid sitevisit date for comment in opportunity ${opportunity._id}`);
          }
        }
      }
    }

    console.log(`Returning ${events.length} calendar events`);
    res.status(200).json(events);

  } catch (error) {
    console.error("Error fetching calendar events:", error);
    res.status(500).json({
      message: "Failed to fetch calendar events",
      error: error.message || "Unknown error occurred"
    });
  }
});


router.post("/send-proposal-mail/:opportunityId", authMiddleware, oppController.sendProposalMail);
router.post("/verify-proposal/:opportunityId", authMiddleware, oppController.verifyProposal);

// ---------------------------------------------------------------------------
// Reminder admin endpoints (admin-only). These exist so the daily cron job
// can be tested + diagnosed in production without waiting until 09:00 IST.
// ---------------------------------------------------------------------------
const {
  runReminderSweep,
  REMINDER_SCHEDULES,
} = require("../services/opportunityReminderService");
const { recordReminderRun, getDueReminderCount } = require("../services/reminderSettingsService");

// GET /api/opportunities/reminders/preview
// Returns the list of opportunities currently due for a reminder, without
// dispatching anything. Useful as a dry-run before triggering the sweep.
router.get(
  "/reminders/preview",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const now = new Date();
      const trackedStatuses = Object.keys(REMINDER_SCHEDULES);

      const due = await Opportunity.find({
        isVisibility: true,
        "reminderState.completed": { $ne: true },
        "reminderState.status": { $in: trackedStatuses },
        "reminderState.nextReminderAt": { $ne: null, $lte: now },
      })
        .populate("client", "name")
        .populate("property", "name")
        .select("client property status reminderState whoLinkthis")
        .lean();

      return res.status(200).json({
        success: true,
        now,
        count: due.length,
        schedules: REMINDER_SCHEDULES,
        opportunities: due.map((o) => ({
          _id: o._id,
          client: o.client?.name,
          property: o.property?.name,
          status: o.status,
          reminderState: o.reminderState,
        })),
      });
    } catch (error) {
      console.error("Error previewing reminders:", error);
      return res
        .status(500)
        .json({ success: false, message: "Failed to preview reminders" });
    }
  }
);

// POST /api/opportunities/reminders/run
// Triggers a sweep immediately. Idempotent (uses conditional state advance).
router.post(
  "/reminders/run",
  authMiddleware,
  requireRoles(...ADMIN_ROLES),
  async (req, res) => {
    try {
      const result = await runReminderSweep();
      await recordReminderRun(req.user._id, result);
      const dueCount = await getDueReminderCount();

      logDataAction(req, {
        action: "admin_action",
        resource: "Task",
        details: {
          action: "reminder_run",
          dispatched: result.dispatched ?? 0,
          skipped: result.skipped ?? 0,
          errors: result.errors ?? 0,
          dueCount,
        },
      }).catch(() => {});

      return res.status(200).json({
        success: true,
        ...result,
        dueCount,
        message: `Sent ${result.dispatched} reminder(s). In-app notifications created for all recipients.`,
      });
    } catch (error) {
      console.error("Error running reminder sweep:", error);
      return res
        .status(500)
        .json({ success: false, message: "Failed to run reminder sweep" });
    }
  }
);

module.exports = router;
