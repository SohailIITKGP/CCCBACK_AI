const express = require("express");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();
const mongoose = require("mongoose");

// Import Models
const Lead = require("../models/Lead");
const Client = require("../models/Client");
const Property = require("../models/propertyModel");
const Opportunity = require("../models/Opportunity");
const User = require("../models/User");

const router = express.Router();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 🔹 Get Model from Collection Name
function getModelFromCollection(collectionName) {
  switch (collectionName.toLowerCase()) {
    case "leads": return Lead;
    case "clients": return Client;
    case "properties": return Property;
    case "opportunities": return Opportunity;
    case "users": return User;
    default: return null;
  }
}

// 🔹 Rule-Based Queries
const ruleBasedQueries = [
  // Lead-Based Queries
  { pattern: /total leads/i, collection: "leads", operation: "countDocuments", query: {} },
  { pattern: /leads with priority (.+)/i, collection: "leads", operation: "find", query: priority => ({ priority: { $regex: new RegExp(`^${priority}$`, "i") } }) },
  { pattern: /leads assigned to (.+)/i, collection: "leads", operation: "find", query: agent => ({ assignedTo: { $regex: new RegExp(agent, "i") } }) },
  { pattern: /leads from (.+)/i, collection: "leads", operation: "find", query: source => ({ sourceOfConnection: { $regex: new RegExp(source, "i") } }) },
  { pattern: /converted leads/i, collection: "leads", operation: "find", query: { isConverted: true } },
  { pattern: /leads created between (.+) and (.+)/i, collection: "leads", operation: "find", query: (startDate, endDate) => ({ createdAt: { $gte: new Date(startDate), $lte: new Date(endDate) } }) },
];

// 🔹 AI Query Generation
async function getAIQuery(userMessage) {
  const model = genAI.getGenerativeModel({ model: "gemini-pro" });

  const schemaDetails = `
    This MongoDB schema represents a Real Estate CRM System used for managing leads, clients, properties, opportunities, and users.

    Leads Collection:
    - _id: Unique identifier for the lead.
    - name: Full name of the lead.
    - contactNumber: Phone number of the lead.
    - email: Email address of the lead.
    - sourceOfConnection: How the lead was generated (LinkedIn, Facebook, etc.).
    - priority: Priority level (Hot, High, Medium, Cold, Low).
    - assignedTo: User assigned to this lead.
    - whoassign: User who assigned the lead.
    - isConverted: Boolean indicating whether the lead has been converted into a client.
    - convertedTo: Reference to the Client model if converted.
    - createdAt: Timestamp of lead creation.
    - updatedAt: Timestamp of last update.

    Clients Collection:
    - _id: Unique identifier for the client.
    - name: Client’s full name.
    - designation: Client's role (Owner, Manager, etc.).
    - contactDetails: Phone number of the client.
    - email: Email address of the client.
    - kindOfBusiness: Type of business (Retail, IT, etc.).
    - city: City where the client operates.
    - preferredArea: Area preference for properties.
    - linkedProperties: Properties associated with this client.
    - opportunities: Opportunities related to this client.
    - priority: Priority level (Hot, High, Medium, Cold, Low).
    - assignedTo: User responsible for handling this client.
    - whoConverted: User who converted the lead into a client.
    - createdAt: Timestamp of client creation.
    - updatedAt: Timestamp of last update.

    Properties Collection:
    - _id: Unique identifier for the property.
    - name: Property name.
    - owner: Name of the property owner.
    - contact: Owner’s contact details.
    - address: Complete address of the property.
    - city: City where the property is located.
    - floor: Floor number (if applicable).
    - area: General area of the property.
    - exactArea: Exact area in square feet.
    - expectedRent: Expected monthly rent.
    - rentType: Type of rent agreement (Including AMC, Excluding AMC, etc.).
    - possession: Current possession status (Ready to Move, Under Construction, etc.).
    - linkedClients: Clients interested in this property.
    - opportunities: Opportunities related to this property.
    - createdAt: Timestamp of property creation.
    - updatedAt: Timestamp of last update.

    Opportunities Collection:
    - _id: Unique identifier for the opportunity.
    - client: Reference to the client interested in the property.
    - property: Reference to the associated property.
    - whoLinkthis: User who created this opportunity.
    - status: Current status of the deal (Pending, Win, Loss, Site-visit, etc.).
    - commentsSection: Comments, follow-ups, and notes related to the deal.
    - agreementDetails: Agreement details, including LOI (Letter of Intent), start date, and end date.
    - createdAt: Timestamp of opportunity creation.
    - updatedAt: Timestamp of last update.

    Users Collection:
    - _id: Unique identifier for the user.
    - name: Full name of the user.
    - email: Email address of the user.
    - phone: Contact number of the user.
    - role: User role (Super Admin, Manager, FE-Property, BO-Client, BO-Lead).
    - assignedClients: List of clients assigned to this user.
    - leadassign: List of leads assigned to the user.
    - propertyCreated: Properties added by the user.
    - status: Current status of the user (Active, Inactive).
    - deviceTokens: Push notification tokens for the user’s devices.
    - createdAt: Timestamp of user creation.
    - updatedAt: Timestamp of last update.
  `;

  const aiResponse = await model.generateContent({
    contents: [{
      parts: [{
        text: `Convert this user query into a MongoDB query JSON format.
        The response MUST be in the following JSON format:

        {
          "collection": "leads | clients | properties | opportunities | users",
          "operation": "find | findOne | countDocuments | aggregate",
          "query": { "FIELD": "VALUE" }
        }

        The collection must be one of: "leads", "clients", "properties", "opportunities", "users".
        Use ONLY lowercase field names (e.g., "priority", not "Priority").
        If the query is unclear, return:
        { "collection": "INVALID", "operation": "", "query": {} }

        DO NOT return extra text.

        Schema Details:
        ${schemaDetails}

        User Query: "${userMessage}"`
      }]
    }]
  });

  let aiOutput = aiResponse.response.text().replace(/```json|```/g, "").trim();
  console.log("AI Output:", aiOutput);

  try {
    const parsedQuery = JSON.parse(aiOutput);
    const validCollections = ["leads", "clients", "properties", "opportunities", "users"];
    if (!validCollections.includes(parsedQuery.collection)) {
      throw new Error("Invalid collection name received from AI.");
    }
    console.log("AI Query:", parsedQuery);
    return parsedQuery;
  } catch (error) {
    console.error(" AI Parsing Error:", error);
    return null;
  }
}
// 🔹 Function to Convert JSON Result into a Natural Answer
async function generateNaturalResponse(userQuery, dbResult) {
  const model = genAI.getGenerativeModel({ model: "gemini-pro" });

  // Handle different types of dbResult
  let formattedResult;
  if (typeof dbResult === "number") {
    // For countDocuments, convert the number to a string
    formattedResult = dbResult.toString();
  } else if (dbResult && typeof dbResult === "object" && !Array.isArray(dbResult)) {
    // For findOne, wrap the object in an array
    formattedResult = [dbResult];
  } else if (Array.isArray(dbResult)) {
    // For find, process the array as usual
    formattedResult = dbResult.map(item => {
      if (item.client && item.client.name) {
        item.client = item.client.name; // Replace client Object ID with client name
      }
      if (item.property && item.property.name) {
        item.property = item.property.name; // Replace property Object ID with property name
      }
      if (item.linkedClients && item.linkedClients.length > 0) {
        item.linkedClients = item.linkedClients.map(client => client.name).join(", "); // Replace linkedClients Object IDs with client names
      }
      return item;
    });
  } else {
    formattedResult = dbResult; // Fallback for other cases
  }

  const response = await model.generateContent({
    contents: [{
      parts: [{
        text: `Convert the following database response into a natural, human-like answer based on the user query:

        User Query: "${userQuery}"
        Database Result: ${JSON.stringify(formattedResult)}

        The response should sound natural and conversational. Do not return JSON.`
      }]
    }]
  });

  return response.response.text().trim();
}
// 🔹 Main Chatbot Route
router.post("/chat", async (req, res) => {
  let { message } = req.body;

  try {
    let queryObject = ruleBasedQueries.find(q => message.match(q.pattern));
    console.log("queryObject", queryObject);

    if (queryObject) {
      const match = message.match(queryObject.pattern);
      if (match && typeof queryObject.query === "function") {
        queryObject.query = queryObject.query(...match.slice(1));
      }
    } else {
      queryObject = await getAIQuery(message);
    }

    if (!queryObject || !queryObject.collection || !queryObject.operation) {
      throw new Error("Could not generate a valid query.");
    }

    const Model = getModelFromCollection(queryObject.collection);
    if (!Model) throw new Error("Invalid collection name.");

    let dbResult;
    if (queryObject.operation === "find") {
      // Populate relevant fields based on the collection
      switch (queryObject.collection) {
        case "opportunities":
          dbResult = await Model.find(queryObject.query)
            .populate("client", "name")
            .populate("property", "name")
            .lean();
          break;
        case "properties":
          dbResult = await Model.find(queryObject.query)
            .populate("linkedClients", "name")
            .lean();
          break;
        default:
          dbResult = await Model.find(queryObject.query).lean();
      }
    } else if (queryObject.operation === "findOne") {
      dbResult = await Model.findOne(queryObject.query).lean();
    } else if (queryObject.operation === "countDocuments") {
      dbResult = await Model.countDocuments(queryObject.query);
    } else if (queryObject.operation === "aggregate") {
      dbResult = await Model.aggregate(queryObject.query);
    } else {
      throw new Error("Invalid MongoDB operation.");
    }

    if (!dbResult || (Array.isArray(dbResult) && dbResult.length === 0)) {
      return res.json({ response: "No data found for your query." });
    }

    const naturalResponse = await generateNaturalResponse(message, dbResult);
    res.json({ response: naturalResponse });
  } catch (error) {
    console.error(" Chatbot Error:", error);
    res.status(500).json({ error: error.message });
  }
});
 


module.exports = router;