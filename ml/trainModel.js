require('dotenv').config();
const tf = require('@tensorflow/tfjs-node');
const mongoose = require("mongoose");
const { preprocessData } = require("../utils/dataPreprocessing");
const { createModel, predict } = require("./model");
const fs = require('fs');
const path = require('path');

async function main() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Database connected for training...");

    const dataset = await preprocessData();

    if (dataset.length === 0) {
      // console.log("No data available for training.");
      return;
    }

    const trainData = dataset.map(item => item.features);
    const trainLabels = dataset.map(item => item.label);

    // console.log("Training Data Sample:", trainData.slice(0, 5));
    console.log("Training Labels Sample:", trainLabels.slice(0, 5));

    const model = createModel();
    await model.fit(tf.tensor2d(trainData), tf.tensor2d(trainLabels, [trainLabels.length, 1]), {
      epochs: 50,
      batchSize: 16,
      shuffle: true,
      validationSplit: 0.2,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          console.log(`Epoch ${epoch + 1}: Loss = ${logs.loss.toFixed(4)}`);
        },
      },
    });

    // Save the model
    const saveDir = path.join(__dirname, 'saved-model');
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir, { recursive: true });
    }
    await model.save(`file://${saveDir}`);
    console.log("Model saved successfully.");

    console.log("Model training completed.");
  } catch (err) {
    console.error("Error during training:", err);
  } finally {
    mongoose.disconnect();
  }
}

main();
