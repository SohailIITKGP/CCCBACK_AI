const mongoose = require("mongoose");

const opportunitySchema = new mongoose.Schema({
  client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
  property: { type: mongoose.Schema.Types.ObjectId, ref: "Property", required: true },
  proposalEmailSentAt: { type: Date },
  proposalEmailSentBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  proposalStatus: {
    type: String,
    enum: ["active", "superseded"],
    default: "active",
    index: true,
  },
  supersededAt: { type: Date },
  supersededByOpportunity: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Opportunity",
    default: null,
  },
  supersedeMeta: {
    overrideReason: { type: String },
    overrideReasonNote: { type: String },
    aiPropertyId: { type: String },
    aiScore: { type: Number },
    newPropertyScore: { type: Number },
    newPropertyId: { type: String },
    supersededByActorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },

  verifiedProposal: { type: Boolean, default: false },
  verifiedProposalAt: { type: Date },
  verifiedProposalBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

  
  whoLinkthis: { type: mongoose.Schema.Types.ObjectId, ref: "User" },


  status: {
    type: String,
    enum: [
      "In Evaluation",
        "Need more details of property (Pictures/video/Data)",
        "Property Approved but Board Approval Pending",
        "Property is ok - Negotiate Rent",
        "Keep this option on Hold",
        "Planning for Site Visit",
        "Site-visit-Positive",
        "Site-visit-Hold",
        "Site-visit-Negative",
        "Site Visit Done - Looks Positive",
        "Already Received from other consultant",
        "Height issue",
        "Frontage issue",
        "Size issue",
        "Rental issue",
        "Not suitable",
        "Looking for Better Option",
        "Asking more details of property ( Pictures / Video / Data )",
      "Hold", "One More Visit","Keep on Hold", "Keep on hold", "Follow Up", "Reject",
       "Approved", "LOI", "Agreement", "Pending", "Win", "Call", "Loss",
       "Property No Longer Available", "Owner Side Pending","Find Franchise Investor",
       "Commercial Details Shared", "Asking For Commercial Details",
       "Asking For More Details", "Find Investor", "Property Approved", "Property approved but owner side pending",
       "Site Visit Done", "After So Many Attempts But Not Responding",
       "Loi Received", "Loi Singed" , "Looking for Capex Investor","He will check and revert" ,"Pending" ],
    default: "Pending",
  },
 
  commentsSection:[{
    tag : { type: String ,
      enum: [
        "In Evaluation",
        "Need more details of property (Pictures/video/Data)",
        "Property Approved but Board Approval Pending",
        "Property is ok - Negotiate Rent",
        "Keep this option on Hold",
        "Planning for Site Visit",

        "Site-visit-Positive",
        "Site-visit-Hold",
        "Site-visit-Negative",
        "Site Visit Done - Looks Positive",
        "Already Received from other consultant",
        "Height issue",
        "Frontage issue",
        "Size issue",
        "Rental issue",
        "Not suitable",
        "Looking for Better Option",
         "Hold", "One More Visit","Keep on Hold", "Keep on hold", "Follow Up", "Reject",
       "Approved", "LOI", "Agreement", "Pending", "Win", "Call", "Loss",
       "Property No Longer Available", "Owner Side Pending", "Property approve but owner side pending", "Find Franchise Investor",
       "Commercial Details Shared", "Asking For Commercial Details",
       "Asking For More Details", "Find Investor", "Property Approved",
       "Site Visit Done", "After So Many Attempts But Not Responding",
       "Loi Received", "Loi Singed" , "Looking for Capex Investor","He will check and revert" ,"Pending",
       "Asking more details of property ( Pictures / Video / Data )"
      ],
      default: "Pending",
    },
    comment: { type: String },
    sitevisit: { date: { type: Date }, notification: { type: Boolean, default: false }, isDone: { type: Boolean, default: false } },   
    followup: { date: { type: Date }, notification: { type: Boolean, default: false }, isDone: { type: Boolean, default: false } },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    whoCommented: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  }],

  loaDetails: {
    dateOfLOI: { type: Date },
    lockinPeriod: { type: String, enum: ["1 yr", "2 yr", "3 yr", "4 yr", "5 yr"] },
    startDate: { type: Date },
    endDate: { type: Date },
    image: { type: String },  
    createdAt: { type: Date    },
    updatedAt: { type: Date  },
    whenCreated: { type: Date  },
    whoCreated: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },

  agreementDetails: {
    date: { type: Date },
    rental: { type: String },
    image: { type: String },  
    createdAt: { type: Date  },
    updatedAt: { type: Date  },
    whenCreated: { type: Date  },
    whoCreated: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  
  // Drives the automated reminder cadence per status. Reset every time the
  // opportunity's status changes (see oppController/status routes).
  reminderState: {
    status: { type: String },
    statusSetAt: { type: Date },
    remindersSent: { type: Number, default: 0 },
    lastReminderAt: { type: Date },
    nextReminderAt: { type: Date, index: true },
    completed: { type: Boolean, default: false },
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  isVisibility: { type: Boolean, default: true },
});

module.exports = mongoose.model("Opportunity", opportunitySchema);
