const mongoose = require("mongoose");

const clientSchema = new mongoose.Schema({
  name: { type: String, required: true },
  contactPerson: { type: String },
  remarks: { type: String },
  state: { type: String },
  designation: { type: String },
  contactDetails: { type: String },
  email: { type: String },
  kindOfBusiness: { type: String },
  format: {
    type: String,
    enum: ["High Level", "Medium Level", "Affordable"],
  },
  clusters: [{ type: String }],
  requirement: { type: String },
  minimumArea: { type: String },
  city: { type: String },
  preferredArea: { type: String },
  expectedRent: { type: String },
  otherPreferredAreas: { type: String },
  specificRequirements: { type: String },
  priority: {
    type: String,
    enum: ["Hot", "High", "Medium", "Cold", "Low"],
    required: true,
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  linkedProperties: [{ type: mongoose.Schema.Types.ObjectId, ref: "Property" }],
  opportunities: [{ type: mongoose.Schema.Types.ObjectId, ref: "Opportunity" }],
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  isVisibility: { type: Boolean, default: true },
  whoConverted: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  /** Same correlationId as source lead for journey tracing. */
  correlationId: { type: String, index: true },
  requirementsHistory: [
    {
      version: Number,
      at: Date,
      actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      source: String,
      snapshot: { type: mongoose.Schema.Types.Mixed },
    },
  ],
  /** FE-Property: optional property options they identified for this client (before formal link). */
  feFoundProperties: [
    {
      property: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Property",
        required: true,
      },
      punchedAt: { type: Date, default: Date.now },
      punchedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
      remarks: { type: String, default: "" },
    },
  ],
});

clientSchema.index({ "feFoundProperties.property": 1 });

// Add indexes for performance optimization
clientSchema.index({ name: 1 });
clientSchema.index({ email: 1 });
clientSchema.index({ contactDetails: 1 });
clientSchema.index({ priority: 1 });
clientSchema.index({ assignedTo: 1 });
clientSchema.index({ whoConverted: 1 });
clientSchema.index({ city: 1 });
clientSchema.index({ createdAt: -1 });
clientSchema.index({ isVisibility: 1 });

module.exports = mongoose.model("Client", clientSchema);
