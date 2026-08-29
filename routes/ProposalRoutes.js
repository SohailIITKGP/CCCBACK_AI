const express = require("express");
const router = express.Router();
const ProposalVisit = require("../models/ProposalVisit");
const Opportunity = require("../models/Opportunity");
const { enqueueOutboxEvent } = require("../services/outboxService");
const { cancelProposalFollowUp } = require("../services/opportunityProposalFollowUpService");
const { cancelProposalStaleCheck } = require("../services/opportunityProposalStaleService");

router.post("/track-visit", async (req, res) => {
  const { opportunityId, name, email, picture, userAgent } = req.body;
  const ipAddress = req.headers["x-forwarded-for"] || req.connection.remoteAddress;

  if (!opportunityId) {
    return res.status(400).json({ error: "opportunityId required" });
  }

  try {
    const opportunity = await Opportunity.findById(opportunityId)
      .populate("client", "correlationId")
      .lean();

    if (!opportunity) {
      return res.status(404).json({ error: "Opportunity not found" });
    }

    if (opportunity.proposalStatus === "superseded") {
      return res.status(410).json({
        error: "proposal_superseded",
        message: "This proposal has been replaced. Please contact your advisor for the latest option.",
        supersededByOpportunityId: opportunity.supersededByOpportunity?.toString() || null,
      });
    }

    const priorVisit = await ProposalVisit.exists({ opportunityId });

    await ProposalVisit.create({
      opportunityId,
      visitorName: name,
      visitorEmail: email,
      visitorPicture: picture,
      userAgent,
      ipAddress,
    });

    if (!priorVisit) {
      const correlationId = opportunity?.client?.correlationId;
      if (correlationId) {
        await cancelProposalFollowUp(opportunityId);
        await cancelProposalStaleCheck(opportunityId);

        await enqueueOutboxEvent({
          eventType: "proposal.viewed",
          aggregateType: "Opportunity",
          aggregateId: opportunityId,
          correlationId,
          schemaVersion: 1,
          metadata: { actor: "client" },
          payload: {
            opportunityId,
            correlationId,
            visitorEmail: email || null,
          },
        });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Visit log error:", err);
    res.status(500).json({ error: "Error tracking visit" });
  }
});

router.get("/:opportunityId/visitors", async (req, res) => {
  try {
    const visits = await ProposalVisit.find({ opportunityId: req.params.opportunityId }).sort({
      visitTime: -1,
    });

    res.json(visits);
  } catch (err) {
    console.error("Get visitors error:", err);
    res.status(500).json({ error: "Failed to fetch visitors" });
  }
});

router.get("/opportunity/:id", async (req, res) => {
  try {
    const opportunity = await Opportunity.findById(req.params.id)
      .populate("client")
      .populate("property");

    if (!opportunity) {
      return res.status(404).json({ message: "Opportunity not found" });
    }

    const superseded = opportunity.proposalStatus === "superseded";
    let replacementProposalLink = null;
    if (superseded && opportunity.supersededByOpportunity) {
      const { buildProposalPublicUrl } = require("../config/opportunityDealFlow");
      replacementProposalLink = buildProposalPublicUrl(
        opportunity.supersededByOpportunity.toString()
      );
    }

    const currentDate = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const propertyImages = [];
    if (opportunity.property && opportunity.property.propertyImages) {
      const images = opportunity.property.propertyImages;
      if (images.frontView) propertyImages.push({ url: images.frontView, title: "Front View" });
      if (images.rhsView) propertyImages.push({ url: images.rhsView, title: "Right Hand Side View" });
      if (images.lhsView) propertyImages.push({ url: images.lhsView, title: "Left Hand Side View" });
      if (images.oppositeView) propertyImages.push({ url: images.oppositeView, title: "Opposite View" });
      if (images.closeView) propertyImages.push({ url: images.closeView, title: "Close View" });
      if (images.buildingView) propertyImages.push({ url: images.buildingView, title: "Building View" });
    }

    const planLayoutImage = [];
    if (opportunity.property.planLayoutImage) {
      const images = opportunity.property.planLayoutImage;
      if (images.planOne) planLayoutImage.push({ url: images.planOne, title: "Floor Plan 1" });
      if (images.planTwo) planLayoutImage.push({ url: images.planTwo, title: "Floor Plan 2" });
    }
    const nearestBrandImage = [];
    if (opportunity.property.nearestBrandImage) {
      const images = opportunity.property.nearestBrandImage;
      if (images.brandOne) nearestBrandImage.push({ url: images.brandOne, title: "Nearby Brand 1" });
      if (images.brandTwo) nearestBrandImage.push({ url: images.brandTwo, title: "Nearby Brand 2" });
      if (images.brandThree) nearestBrandImage.push({ url: images.brandThree, title: "Nearby Brand 3" });
      if (images.brandFour) nearestBrandImage.push({ url: images.brandFour, title: "Nearby Brand 4" });
      if (images.brandFive) nearestBrandImage.push({ url: images.brandFive, title: "Nearby Brand 5" });
      if (images.brandSix) nearestBrandImage.push({ url: images.brandSix, title: "Nearby Brand 6" });
      if (images.brandSeven) nearestBrandImage.push({ url: images.brandSeven, title: "Nearby Brand 7" });
      if (images.brandEight) nearestBrandImage.push({ url: images.brandEight, title: "Nearby Brand 8" });
      if (images.brandNine) nearestBrandImage.push({ url: images.brandNine, title: "Nearby Brand 9" });
      if (images.brandTen) nearestBrandImage.push({ url: images.brandTen, title: "Nearby Brand 10" });
    }

    const insideViewImage = [];
    if (opportunity.property.insideViewImage) {
      const images = opportunity.property.insideViewImage;
      if (images.insideOne) insideViewImage.push({ url: images.insideOne, title: "Inside View 1" });
      if (images.insideTwo) insideViewImage.push({ url: images.insideTwo, title: "Inside View 2" });
      if (images.insideThree) insideViewImage.push({ url: images.insideThree, title: "Inside View 3" });
      if (images.insideFour) insideViewImage.push({ url: images.insideFour, title: "Inside View 4" });
    }

    const brochurePdf = [];
    if (opportunity.property.brochurePdf) {
      const pdfs = opportunity.property.brochurePdf;
      if (pdfs.brochureOne) brochurePdf.push({ url: pdfs.brochureOne, title: "Brochure 1" });
    }

    const propertyVideo = [];
    if (opportunity.property.propertyVideo?.videoOne) {
      propertyVideo.push({
        url: opportunity.property.propertyVideo.videoOne,
        title: "Property Video",
        type: "video",
      });
    }

    const roadmap = [];
    if (opportunity.property.roadmap) {
      const roadmapImages = opportunity.property.roadmap;
      if (roadmapImages.roadmapOne) roadmap.push({ url: roadmapImages.roadmapOne, title: "Roadmap 1" });
    }

    res.status(200).json({
      propertyId: opportunity.property?._id,
      proposalStatus: opportunity.proposalStatus || "active",
      superseded,
      supersededAt: opportunity.supersededAt || null,
      replacementProposalLink,
      roadmap: roadmap,
      proposalDate: currentDate,
      clientName: opportunity.client?.name || "N/A",
      verifiedProposal: opportunity.verifiedProposal || false,
      propertyDetails: {
        name: opportunity.property?.name || "N/A",
        address: opportunity.property?.address || "N/A",
        googleLocation: opportunity.property?.pinPointLocation || "N/A",
        floor: opportunity.property?.floor || "N/A",
        carpetArea: opportunity.property?.area || "N/A",
        exactArea: opportunity.property?.exactArea || "N/A",
        frontage: opportunity.property?.frontageRoad || "N/A",
        height: opportunity.property?.height || "N/A",
        possession: opportunity.property?.possession || "N/A",
        expectedRent: opportunity.property?.expectedRent || "N/A",
        shopNo: opportunity.property?.shopNo || "N/A",
        lumsumRent: opportunity.property?.lumsumRent || "N/A",
        city: opportunity.property?.city || "N/A",
        roadName: opportunity.property?.roadName || "N/A",
      },
      propertyImages: propertyImages,
      planLayoutImage: planLayoutImage,
      nearestBrandImage: nearestBrandImage,
      insideViewImage: insideViewImage,
      brochurePdf: brochurePdf,
      propertyVideo: propertyVideo,
      companyInfo: {
        name: "Rewa Realtors",
        description:
          "Rewa Realtors is a trusted name in the world of real estate. We are a leading commercial real estate company with over 21 years of experience in the industry. At Rewa Realtors, we understand that commercial real estate is not just about buying and selling properties, it's about building long-lasting relationships with our clients.\nOur team of experts brings unparalleled knowledge and expertise to every project, ensuring that we deliver exceptional results every time. We specialize in providing customized solutions to meet the unique needs of our clients, whether it's finding the perfect office space or negotiating a lease agreement.\nWe take pride in our commitment to transparency and ethical business practices. Our goal is to ensure that every client has a positive experience with us, from start to finish. We believe that our success is measured by the success of our clients, and we work tirelessly to ensure that they achieve their goals.\nFor more details please visit our website : www.Rewaaltors.com",
        contactInfo: {
          address: "405, SANGIN ASPIRE, NEARRTO, PAL SURAT – GUJARAT",
          website: "www.Rewaaltors.com",
          email: "mehul@Rewaaltors.com",
          phoneNumbers: ["+91 97277 29812", "+91 96646 53165", "+91 63519 99374"],
        },
      },
    });
  } catch (error) {
    console.error("Error fetching opportunity:", error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
