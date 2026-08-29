const dotenv = require("dotenv");
const mongoose = require("mongoose");

dotenv.config();

const connectDB = require("../config/db");
const Property = require("../models/propertyModel");

const SOURCE_BASE_REGEX = /^https:\/\/rewacrm\.s3\.ap-south-1\.amazonaws\.com\/(.+)$/i;
const TARGET_BASE = "https://rewacrm.blr1.cdn.digitaloceanspaces.com/";
// https://rewacrm.blr1.cdn.digitaloceanspaces.com/1741802893323_p2.jpg

function replaceUrlBaseIfNeeded(input) {
  if (typeof input !== "string" || input.trim() === "") return { changed: false, value: input };
  const match = input.match(SOURCE_BASE_REGEX);
  if (!match) return { changed: false, value: input };
  const suffixPath = match[1];
  return { changed: true, value: TARGET_BASE + suffixPath };
}

async function processProperties(dryRun, summary) {
  const cursor = Property.find({}).cursor();
  for await (const doc of cursor) {
    let changed = false;

    // Process propertyImages object
    if (doc.propertyImages) {
      const propertyImageFields = ['frontView', 'rhsView', 'lhsView', 'oppositeView', 'closeView', 'buildingView'];
      for (const field of propertyImageFields) {
        if (doc.propertyImages[field]) {
          const { changed: c, value } = replaceUrlBaseIfNeeded(doc.propertyImages[field]);
          if (c) {
            doc.propertyImages[field] = value;
            changed = true;
            summary.Property[`propertyImages.${field}`]++;
          }
        }
      }
      if (changed) {
        doc.markModified("propertyImages");
      }
    }

    // Process nearestBrandImage object
    if (doc.nearestBrandImage) {
      const brandFields = ['brandOne', 'brandTwo', 'brandThree', 'brandFour', 'brandFive', 
                          'brandSix', 'brandSeven', 'brandEight', 'brandNine', 'brandTen'];
      let brandChanged = false;
      for (const field of brandFields) {
        if (doc.nearestBrandImage[field]) {
          const { changed: c, value } = replaceUrlBaseIfNeeded(doc.nearestBrandImage[field]);
          if (c) {
            doc.nearestBrandImage[field] = value;
            brandChanged = true;
            summary.Property[`nearestBrandImage.${field}`]++;
          }
        }
      }
      if (brandChanged) {
        doc.markModified("nearestBrandImage");
        changed = true;
      }
    }

    // Process planLayoutImage object
    if (doc.planLayoutImage) {
      const planFields = ['planOne', 'planTwo'];
      let planChanged = false;
      for (const field of planFields) {
        if (doc.planLayoutImage[field]) {
          const { changed: c, value } = replaceUrlBaseIfNeeded(doc.planLayoutImage[field]);
          if (c) {
            doc.planLayoutImage[field] = value;
            planChanged = true;
            summary.Property[`planLayoutImage.${field}`]++;
          }
        }
      }
      if (planChanged) {
        doc.markModified("planLayoutImage");
        changed = true;
      }
    }

    // Process insideViewImage object
    if (doc.insideViewImage) {
      const insideFields = ['insideOne', 'insideTwo', 'insideThree', 'insideFour'];
      let insideChanged = false;
      for (const field of insideFields) {
        if (doc.insideViewImage[field]) {
          const { changed: c, value } = replaceUrlBaseIfNeeded(doc.insideViewImage[field]);
          if (c) {
            doc.insideViewImage[field] = value;
            insideChanged = true;
            summary.Property[`insideViewImage.${field}`]++;
          }
        }
      }
      if (insideChanged) {
        doc.markModified("insideViewImage");
        changed = true;
      }
    }

    // Process brochurePdf object
    if (doc.brochurePdf && doc.brochurePdf.brochureOne) {
      const { changed: c, value } = replaceUrlBaseIfNeeded(doc.brochurePdf.brochureOne);
      if (c) {
        doc.brochurePdf.brochureOne = value;
        doc.markModified("brochurePdf");
        changed = true;
        summary.Property["brochurePdf.brochureOne"]++;
      }
    }

    // Process roadmap object
    if (doc.roadmap && doc.roadmap.roadmapOne) {
      const { changed: c, value } = replaceUrlBaseIfNeeded(doc.roadmap.roadmapOne);
      if (c) {
        doc.roadmap.roadmapOne = value;
        doc.markModified("roadmap");
        changed = true;
        summary.Property["roadmap.roadmapOne"]++;
      }
    }

    if (changed && !dryRun) {
      await doc.save();
    }
  }
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");

  const summary = {
    
    Property: {
      "propertyImages.frontView": 0,
      "propertyImages.rhsView": 0,
      "propertyImages.lhsView": 0,
      "propertyImages.oppositeView": 0,
      "propertyImages.closeView": 0,
      "propertyImages.buildingView": 0,
      "nearestBrandImage.brandOne": 0,
      "nearestBrandImage.brandTwo": 0,
      "nearestBrandImage.brandThree": 0,
      "nearestBrandImage.brandFour": 0,
      "nearestBrandImage.brandFive": 0,
      "nearestBrandImage.brandSix": 0,
      "nearestBrandImage.brandSeven": 0,
      "nearestBrandImage.brandEight": 0,
      "nearestBrandImage.brandNine": 0,
      "nearestBrandImage.brandTen": 0,
      "planLayoutImage.planOne": 0,
      "planLayoutImage.planTwo": 0,
      "insideViewImage.insideOne": 0,
      "insideViewImage.insideTwo": 0,
      "insideViewImage.insideThree": 0,
      "insideViewImage.insideFour": 0,
      "brochurePdf.brochureOne": 0,
      "roadmap.roadmapOne": 0,
    },
  };

  try {
    await connectDB();

   
    await processProperties(dryRun, summary);

    console.log("\nMigration summary (" + (dryRun ? "dry-run" : "executed") + "):");
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error("Migration error:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
}

run();