const mongoose = require('mongoose');
const Property = require('../models/propertyModel');
const connectDB = require('../config/db');
require('dotenv').config();

// Update existing properties to add isArchive field
const updateExistingProperties = async () => {
  try {
    console.log('Starting to update existing properties...');
    
    // Update all properties that don't have isArchive field
    const result = await Property.updateMany(
      { isArchive: { $exists: false } }, // Find properties without isArchive field
      { 
        $set: { 
          isArchive: false // Set default value
        } 
      }
    );

    console.log(`Updated ${result.modifiedCount} properties with isArchive: false`);
    
  } catch (error) {
    console.error('Error updating properties:', error);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed');
  }
};

// Run the script
const runScript = async () => {
  await connectDB();
  await updateExistingProperties();
};

runScript();