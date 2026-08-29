const express = require('express');
const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const Client = require('../models/Client');
const Property = require('../models/propertyModel');
const Opportunity = require('../models/Opportunity');

const router = express.Router();


router.get('/getallLeads', async (req, res) => {
  try {
    const leads = await Lead.find();
    res.status(200).json({ success: true, data: leads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// Fetch progression tracking data for a lead
router.get('/track/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;

    // Fetch Lead Details
    const lead = await Lead.findById(leadId).populate('convertedTo');
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Check if Lead is converted to Client
    const client = await Client.findOne({ email: lead.email })
      .populate('linkedProperties')
      .populate({
        path: 'opportunities',
        populate: [{
          path: 'property',
          model: 'Property',
        }],
      });

    const clientData = client ? {
      id: client._id,
      name: client.name,
      contactDetails: client.contactDetails,
      email: client.email,
      assignTo: client.assignedTo,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      linkedProperties: client.linkedProperties.map(property => ({
        id: property._id,
        name: property.name,
        address: property.address,
        pinPointLocation: property.pinPointLocation,
        floor: property.floor,
        area: property.area,
        exactArea: property.exactArea,
        height: property.height,
        frontageRoad: property.frontageRoad,
        expectedRent: property.expectedRent,
        rentType: property.rentType,
        possession: property.possession,
        propertyImages: property.propertyImages,
        planLayouts: property.planLayouts,
        createdAt: property.createdAt,
        updatedAt: property.updatedAt,
      })),
      opportunities: client.opportunities.map(opportunity => {
         

        return {
          id: opportunity._id,
          client: opportunity.client._id,
          property: opportunity.property._id,
          property: {
            id: opportunity.property._id,
            name: opportunity.property.name,
            address: opportunity.property.address,
          },
          status: opportunity.status,


           

          loaDetails: {
            dateOfLOI: opportunity.loaDetails.dateOfLOI,
            lockinPeriod: opportunity.loaDetails.lockinPeriod,
            startDate: opportunity.loaDetails.startDate,
            endDate: opportunity.loaDetails.endDate,
            image: opportunity.loaDetails.image,
            createdAt: opportunity.loaDetails.createdAt,
            updatedAt: opportunity.loaDetails.updatedAt,
          },
          agreementDetails: {
            date: opportunity.agreementDetails.date,
            rental: opportunity.agreementDetails.rental,
            image: opportunity.agreementDetails.image,
            createdAt: opportunity.agreementDetails.createdAt,
          },
          createdAt: opportunity.createdAt,
          updatedAt: opportunity.updatedAt,
        };
      }),
    } : null;

    // Response
    res.status(200).json({
      lead,
      client: clientData,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server Error' });
  }
});




module.exports = router;
