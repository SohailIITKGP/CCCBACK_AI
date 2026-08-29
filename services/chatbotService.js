// import mongoose from 'mongoose';

// import mongoose from "mongoose";
const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const Client = require('../models/Client');
const Property = require('../models/propertyModel');
const Opportunity = require('../models/Opportunity');

exports.executeQuery = async (queryText) => {
  try {
    const queryFunction = new Function("Lead", "Client", "Property", "Opportunity", "return " + queryText);
    const result = await queryFunction(Lead, Client, Property, Opportunity)();
    return JSON.stringify(result, null, 2);
  } catch (error) {
    return `Error executing query: ${error.message}`;
  }
};

