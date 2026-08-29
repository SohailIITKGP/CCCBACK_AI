const mongoose = require('mongoose');

const propertySchema = new mongoose.Schema({
  name: { type: String },
  owner: { type: String},
  propertySourceName: { type: String},
  shopNo: { type: String},
  lumsumRent: { type: String},
  city: { type: String},
  clusters: [{ type: String }],
  format: {
    type: String,
    enum: ["High Level", "Medium Level", "Affordable"],
  },
  brandCategory: { type: String },
  docklevelnoQty: { type: String},
  fireSafety: { type: String},
  washroomQty: { type: String},
  floorStrength: { type: String},
  roadName: { type: String},
  contact: { type: String},
  address: { type: String},
  category: { type: String},
  pinPointLocation: { type: String},  
  floor: { type: String },
  area: { type: String},
  isRead: { type: Boolean, default: false },
  exactArea: { type: String },  
  height: { type: String },
  frontageRoad: { type: String},  
  expectedRent: { type: String },
  rentType: { type: String },  
  possession: { type: String },
  propertyImages: {
    frontView: { type: String },
    rhsView: { type: String },
    lhsView: { type: String },
    oppositeView: { type: String },
    closeView: { type: String },
    buildingView: { type: String }
  },
  nearestBrandImage: { 
    brandOne: { type: String },
    brandTwo: { type: String },
    brandThree: { type: String },
    brandFour: { type: String },
    brandFive: { type: String },
    brandSix: { type: String },
    brandSeven: { type: String },
    brandEight: { type: String },
    brandNine: { type: String },
    brandTen: { type: String },
  },

  planLayoutImage: {  
    planOne: { type: String },
    planTwo: { type: String },
  },

  insideViewImage: {
    insideOne: { type: String },
    insideTwo: { type: String },
    insideThree: { type: String },
    insideFour: { type: String },
  },

  brochurePdf: { 
    brochureOne: { type: String },
   },

  propertyVideo: {
    videoOne: { type: String },
  },

  roadmap: {
    roadmapOne: { type: String },
  } ,
  
  linkedClients: [{ type: mongoose.Schema.Types.ObjectId, ref: "Client" }],
  opportunities: [{ type: mongoose.Schema.Types.ObjectId, ref: "Opportunity" }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  isVisibility: { type: Boolean, default: true },
  isArchive: { type: Boolean, default: false },
  /** Portal workflow: draft (brokerage submit) → approved (open) → closed */
  propertyStatus: {
    type: String,
    enum: ["draft", "approved", "closed"],
    default: "approved",
    index: true,
  },
  submissionNote: { type: String, default: "" },
  rejectionReason: { type: String, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
  whoCreated: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  whoLinkthis: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
});

// Add indexes for performance optimization
propertySchema.index({ name: 1 });
propertySchema.index({ owner: 1 });
propertySchema.index({ city: 1 });
propertySchema.index({ whoCreated: 1 });
propertySchema.index({ whoLinkthis: 1 });
propertySchema.index({ createdAt: -1 });
propertySchema.index({ isVisibility: 1 });
propertySchema.index({ isArchive: 1 });

const Property = mongoose.model('Property', propertySchema);
module.exports = Property;
