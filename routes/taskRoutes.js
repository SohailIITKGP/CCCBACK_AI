const express = require('express');
const Task = require('../models/Task');
const Opportunity = require("../models/Opportunity");
const Client = require("../models/Client");
const Property = require("../models/propertyModel");
const Lead = require("../models/Lead");


const router = express.Router();





// get count 
router.get('/count', async (req, res) => {
  try {
    const leadCount = await Lead.countDocuments();
    const opportunityCount = await Opportunity.countDocuments();
    const clientCount = await Client.countDocuments();
    const propertyCount = await Property.countDocuments();
    
    const count = { 
      Lead: leadCount, 
      Opportunity: opportunityCount, 
      Client: clientCount, 
      Property: propertyCount 
    }; 

    res.status(200).json({ count });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
