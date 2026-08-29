const mongoose = require('mongoose');

const proposalVisitSchema = new mongoose.Schema({
  opportunityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Opportunity', required: true },
  visitorName: String,
  visitorEmail: String,
  visitorPicture: String,
  userAgent: String,
  visitTime: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ProposalVisit', proposalVisitSchema);
