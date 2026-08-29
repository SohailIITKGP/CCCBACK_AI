// /scripts/preprocessData.js

require('dotenv').config();
const { preprocessData } = require('../utils/dataPreprocessing');

async function runPreprocessing() {
  try {
    console.log("Starting data preprocessing...");
    const dataset = await preprocessData();

    if (dataset.length === 0) {
      console.log("No data available for preprocessing.");
    } else {
      console.log("Processed Dataset:", dataset);
      console.log(`Data preprocessing completed successfully with ${dataset.length} records.`);
    }
  } catch (error) {
    console.error("Error during data preprocessing:", error);
  }
}

runPreprocessing();
