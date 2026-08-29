# Real Estate CRM System Documentation

## 📋 Table of Contents
1. [Overview](#overview)
2. [Project Structure](#project-structure)
3. [Technology Stack](#technology-stack)
4. [Setup Instructions](#setup-instructions)
5. [API Documentation](#api-documentation)
6. [Database Models](#database-models)
7. [Features](#features)
8. [Deployment](#deployment)

## 🏗️ Overview

This is a comprehensive Real Estate CRM (Customer Relationship Management) system built with Node.js, Express.js, and MongoDB. The system manages leads, clients, properties, opportunities, and provides advanced features like AI-powered chatbot, reporting, and proposal generation.

## 📁 Project Structure

```
cccback/
├── 📁 accets/                    # Static assets
│   └── logo.png
├── 📁 agents/                    # AI/ML related files
├── 📁 config/                    # Configuration files
│   ├── db.js                     # Database connection
│   └── jwt.js                    # JWT configuration
├── 📁 controllers/               # Business logic controllers
│   ├── authController.js         # Authentication logic
│   ├── clientController.js       # Client management
│   ├── leadController.js         # Lead management
│   ├── oppController.js          # Opportunity management
│   ├── propertyController.js     # Property management
│   ├── notificationController.js # Notification handling
│   ├── reportController.js       # Reporting logic
│   └── ...
├── 📁 middlewares/               # Express middlewares
│   ├── authMiddleware.js         # Authentication middleware
│   └── errorHandler.js           # Error handling
├── 📁 models/                    # MongoDB schemas
│   ├── User.js                   # User model
│   ├── Lead.js                   # Lead model
│   ├── Client.js                 # Client model
│   ├── Property.js               # Property model
│   ├── Opportunity.js            # Opportunity model
│   └── ...
├── 📁 routes/                    # API routes
│   ├── authRoutes.js             # Authentication routes
│   ├── leadRoutes.js             # Lead management routes
│   ├── clientRoutes.js           # Client management routes
│   ├── propertyRoutes.js         # Property management routes
│   ├── opportunityRoutes.js      # Opportunity management routes
│   ├── chatbotRoutes.js          # AI chatbot routes
│   ├── reportRoutes.js           # Reporting routes
│   └── ...
├── 📁 services/                  # Business services
│   └── chatbotService.js         # AI chatbot service
├── 📁 utils/                     # Utility functions
│   ├── helpers.js                # Helper functions
│   ├── validators.js             # Validation functions
│   └── notification.js           # Notification utilities
├── 📁 public/                    # Public static files
│   ├── calendar/                 # Calendar files
│   ├── images/                   # Images
│   └── pdfs/                     # Generated PDFs
├── 📁 uploads/                   # File uploads
├── 📁 ml/                        # Machine learning models
├── app.js                        # Express app configuration
├── server.js                     # Server entry point
└── package.json                  # Dependencies and scripts
```

## 🛠️ Technology Stack

### Backend
- **Node.js** - Runtime environment
- **Express.js** - Web framework
- **MongoDB** - Database
- **Mongoose** - ODM for MongoDB
- **JWT** - Authentication
- **bcrypt** - Password hashing
- **multer** - File uploads
- **nodemailer** - Email functionality
- **socket.io** - Real-time communication

### AI/ML
- **TensorFlow.js** - Machine learning
- **Google Generative AI** - AI chatbot
- **Google Translate API** - Translation services

### External Services
- **Firebase Admin SDK** - Push notifications
- **Gmail SMTP / IMAP** - Outbound email and inbound reply polling
- **Puppeteer** - PDF generation

## 🚀 Setup Instructions

### Prerequisites
- Node.js (v14 or higher)
- MongoDB
- npm or yarn

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd cccback
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Configuration**
   Create a `.env` file in the root directory:
   ```env
   PORT=5000
   MONGO_URI=mongodb://localhost:27017/real-estate-crm
   JWT_SECRET=your-jwt-secret
   GEMINI_API_KEY=your-gemini-api-key
   FIREBASE_PROJECT_ID=your-firebase-project-id
   FIREBASE_PRIVATE_KEY=your-firebase-private-key
   FIREBASE_CLIENT_EMAIL=your-firebase-client-email
   EMAIL_USER=your-gmail@gmail.com
   EMAIL_PASS=your-gmail-app-password
   EMAIL_SMTP_HOST=smtp.gmail.com
   EMAIL_SMTP_PORT=587
   EMAIL_SMTP_SECURE=false
   GMAIL_IMAP_USER=your-gmail@gmail.com
   GMAIL_IMAP_PASS=your-gmail-app-password
   GMAIL_INBOUND_ENABLED=true

   # Outbound on DigitalOcean (Gmail SMTP often blocked on VPS — use Gmail API):
   # GMAIL_CLIENT_ID=...
   # GMAIL_CLIENT_SECRET=...
   # GMAIL_REFRESH_TOKEN=...   # node scripts/setupGmailApiAuth.js
   # EMAIL_SEND_VIA=gmail_api
   ```

4. **Start the server**
   ```bash
   npm start
   ```

## 📚 API Documentation

### Base URL
```
http://localhost:5000/api
```

### Authentication Endpoints

#### POST `/auth/login`
User login endpoint.
- **Body:**
  ```json
  {
    "email": "user@example.com",
    "password": "password123"
  }
  ```
- **Response:**
  ```json
  {
    "token": "jwt-token",
    "user": {
      "id": "user-id",
      "name": "User Name",
      "email": "user@example.com",
      "role": "Manager"
    }
  }
  ```

#### POST `/auth/change-password`
Change user password (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "currentPassword": "old-password",
    "newPassword": "new-password"
  }
  ```

#### POST `/auth/add-device-token`
Add device token for push notifications (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "deviceToken": "firebase-device-token"
  }
  ```

### Lead Management Endpoints

#### POST `/leads/add`
Create a new lead (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "name": "Lead Name",
    "contactNumber": "+1234567890",
    "email": "lead@example.com",
    "sourceOfConnection": "LinkedIn",
    "priority": "Hot",
    "remarks": "Interested in commercial property"
  }
  ```

#### GET `/leads`
Get all leads (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Query Parameters:**
  - `page`: Page number
  - `limit`: Items per page
  - `status`: Filter by status
  - `priority`: Filter by priority

#### PUT `/leads/update/:id`
Update a lead.
- **Body:** Lead data to update

#### DELETE `/leads/delete/:id`
Delete a lead.

#### POST `/leads/:id/convert-to-client`
Convert a lead to a client (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### PUT `/leads/asignleademployee/:leadId`
Assign a lead to an employee.
- **Body:**
  ```json
  {
    "employeeId": "employee-user-id"
  }
  ```

#### PUT `/leads/updateStatus/:id`
Update lead status (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "status": "Done"
  }
  ```

#### GET `/leads/getAllLeadsClosed`
Get all closed leads (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

### Client Management Endpoints

#### POST `/clients`
Create a new client (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "name": "Client Name",
    "contactDetails": "+1234567890",
    "email": "client@example.com",
    "kindOfBusiness": "Retail",
    "city": "Mumbai",
    "preferredArea": "Bandra",
    "priority": "Hot"
  }
  ```

#### GET `/clients`
Get all clients (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### GET `/clients/:id`
View a specific client (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### PUT `/clients/:id`
Update a client (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Body:** Client data to update

#### PUT `/clients/:clientId/assign`
Assign a client to an employee (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "employeeId": "employee-user-id"
  }
  ```

#### DELETE `/clients/:id`
Delete a client (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

### Property Management Endpoints

#### POST `/properties`
Create a new property (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Body:** FormData with property details and images
  - `name`: Property name
  - `owner`: Property owner
  - `address`: Property address
  - `city`: City
  - `area`: Area in sq ft
  - `expectedRent`: Expected rent
  - `propertyImages`: Array of property images
  - `planLayouts`: Array of plan layout images

#### GET `/properties`
Get all properties (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### GET `/properties/myproperty`
Get properties for linking (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### GET `/properties/:id`
Get property by ID (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### PUT `/properties/:id`
Update a property (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Body:** FormData with updated property details

#### DELETE `/properties/:id`
Delete a property (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

### Opportunity Management Endpoints

#### GET `/opportunities`
Get all opportunities (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Access Control:**
  - Super Admin, Manager: Full access
  - BO-Client: Restricted access (no property details)
  - Lead-Employee: Only assigned opportunities

#### POST `/opportunities/:id/loaadd`
Add LOA (Letter of Intent) details (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "dateOfLOI": "2024-01-15",
    "lockinPeriod": "3 yr",
    "startDate": "2024-02-01",
    "endDate": "2027-01-31",
    "image": "loa-document-url"
  }
  ```

#### PUT `/opportunities/:id/loa`
Update LOA details (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### POST `/opportunities/:id/agreementadd`
Add agreement details (requires authentication).
- **Headers:** `Authorization: Bearer <token>`
- **Body:**
  ```json
  {
    "date": "2024-01-20",
    "rental": "50000",
    "image": "agreement-document-url"
  }
  ```

#### PUT `/opportunities/:id/agreement`
Update agreement details (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

### Task Management Endpoints

#### GET `/count`
Get counts of all entities.
- **Response:**
  ```json
  {
    "count": {
      "Lead": 150,
      "Opportunity": 75,
      "Client": 100,
      "Property": 200
    }
  }
  ```

### Notification Endpoints

#### GET `/notifications`
Get all notifications.

#### GET `/notifications/count`
Get count of unread notifications.

#### PUT `/notifications/:id/read`
Mark notification as read.

#### POST `/notifications/send`
Send notification to user.
- **Body:**
  ```json
  {
    "userId": "user-id",
    "title": "Notification Title",
    "message": "Notification message"
  }
  ```

### AI Chatbot Endpoints

#### POST `/chat/query`
Send query to AI chatbot.
- **Body:**
  ```json
  {
    "message": "How many leads do we have?"
  }
  ```
- **Response:**
  ```json
  {
    "response": "You have 150 leads in total.",
    "data": [...]
  }
  ```

### Reporting Endpoints

#### GET `/reports/tag-reports`
Get tag-based reports (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### GET `/reports/lead-generation-report`
Get lead generation report (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### GET `/reports/lead-to-opportunity-report`
Get lead to opportunity conversion report (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### GET `/reports/brand-wise-report`
Get brand-wise report (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### GET `/reports/city-wise-report/:city`
Get city-wise report (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### GET `/reports/fe-property-report`
Get frontend property report (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### GET `/reports/summary-report`
Get summary report (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### GET `/reports/myreport`
Get employee performance report (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

### Proposal Management Endpoints

#### POST `/proposal/track-visit`
Track proposal visit.
- **Body:**
  ```json
  {
    "opportunityId": "opportunity-id",
    "name": "Visitor Name",
    "email": "visitor@example.com",
    "picture": "profile-picture-url"
  }
  ```

#### GET `/proposal/:opportunityId/visitors`
Get visitors for an opportunity.

#### GET `/proposal/opportunity/:id`
Get opportunity details for proposal.
- **Response:** Complete opportunity data with property details and company information

### Link Management Endpoints

#### POST `/link`
Create links between entities.

#### GET `/link`
Get all links.

### User Management Endpoints

#### GET `/users`
Get all users (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### POST `/users`
Create a new user (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### PUT `/users/:id`
Update a user (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

#### DELETE `/users/:id`
Delete a user (requires authentication).
- **Headers:** `Authorization: Bearer <token>`

### Tracking Endpoints

#### GET `/track`
Get tracking information.

## 🗄️ Database Models

### User Model
```javascript
{
  name: String (required),
  email: String (required, unique),
  phone: String (required),
  password: String (required, hashed),
  role: String (enum: ["Super Admin", "Manager", "FE-Property", "BO-Client", "BO-Lead", "Lead-Employee"]),
  status: String (enum: ["Active", "Inactive"]),
  assignedClients: [ObjectId],
  leadassign: [ObjectId],
  deviceTokens: [String],
  timestamps: true
}
```

### Lead Model
```javascript
{
  name: String (required),
  contactNumber: String,
  email: String,
  sourceOfConnection: String,
  assignedTo: ObjectId (ref: User),
  priority: String (enum: ["Hot", "High", "Medium", "Cold", "Low"]),
  status: String (enum: ["Done", "Pending", "call not received"]),
  isConverted: Boolean,
  convertedTo: ObjectId (ref: Client),
  timestamps: true
}
```

### Client Model
```javascript
{
  name: String (required),
  contactDetails: String,
  email: String,
  kindOfBusiness: String,
  city: String,
  preferredArea: String,
  priority: String (enum: ["Hot", "High", "Medium", "Cold", "Low"]),
  assignedTo: ObjectId (ref: User),
  linkedProperties: [ObjectId (ref: Property)],
  opportunities: [ObjectId (ref: Opportunity)],
  isVisibility: Boolean,
  timestamps: true
}
```

### Property Model
```javascript
{
  name: String,
  owner: String,
  address: String,
  city: String,
  area: String,
  exactArea: String,
  expectedRent: String,
  rentType: String,
  possession: String,
  propertyImages: {
    frontView: String,
    rhsView: String,
    lhsView: String,
    oppositeView: String,
    closeView: String,
    buildingView: String
  },
  planLayoutImage: {
    planOne: String,
    planTwo: String
  },
  insideViewImage: {
    insideOne: String,
    insideTwo: String,
    insideThree: String,
    insideFour: String
  },
  linkedClients: [ObjectId (ref: Client)],
  opportunities: [ObjectId (ref: Opportunity)],
  isVisibility: Boolean,
  timestamps: true
}
```

### Opportunity Model
```javascript
{
  client: ObjectId (ref: Client, required),
  property: ObjectId (ref: Property, required),
  whoLinkthis: ObjectId (ref: User),
  status: String (enum: ["Pending", "Win", "Loss", "Site-visit", ...]),
  commentsSection: [{
    tag: String,
    comment: String,
    sitevisit: { date: Date, notification: Boolean, isDone: Boolean },
    followup: { date: Date, notification: Boolean, isDone: Boolean },
    whoCommented: ObjectId (ref: User)
  }],
  loaDetails: {
    dateOfLOI: Date,
    lockinPeriod: String,
    startDate: Date,
    endDate: Date,
    image: String
  },
  agreementDetails: {
    date: Date,
    rental: String,
    image: String
  },
  isVisibility: Boolean,
  timestamps: true
}
```

## ✨ Features

### Core Features
- **Lead Management**: Create, track, and convert leads
- **Client Management**: Manage client relationships and preferences
- **Property Management**: Comprehensive property listings with images
- **Opportunity Management**: Track deals from initial contact to closure
- **User Management**: Role-based access control
- **File Upload**: Support for images and documents
- **Email Integration**: Automated email notifications
- **Push Notifications**: Real-time notifications via Firebase

### Advanced Features
- **AI Chatbot**: Natural language queries using Google Generative AI
- **Reporting System**: Comprehensive analytics and reports
- **Proposal Generation**: Automated PDF proposal creation
- **Calendar Integration**: Schedule management and reminders
- **Multi-language Support**: Translation capabilities
- **Machine Learning**: Predictive analytics for lead scoring

### Security Features
- **JWT Authentication**: Secure token-based authentication
- **Role-based Access Control**: Different permissions for different user roles
- **Password Hashing**: Secure password storage using bcrypt
- **Input Validation**: Comprehensive data validation
- **Error Handling**: Centralized error management

## 🚀 Deployment

### Environment Variables
Ensure all required environment variables are set:
- `PORT`: Server port
- `MONGO_URI`: MongoDB connection string
- `JWT_SECRET`: JWT signing secret
- `GEMINI_API_KEY`: Google Generative AI API key
- `FIREBASE_PROJECT_ID`: Firebase project ID
- `FIREBASE_PRIVATE_KEY`: Firebase private key
- `FIREBASE_CLIENT_EMAIL`: Firebase client email
- `EMAIL_USER` / `EMAIL_PASS`: Gmail account and app password for SMTP
- `GMAIL_IMAP_USER` / `GMAIL_IMAP_PASS`: Same Gmail credentials for inbound reply polling

### Production Deployment
1. Set up MongoDB Atlas or local MongoDB
2. Configure environment variables
3. Install dependencies: `npm install`
4. Start the server: `npm start`
5. Set up reverse proxy (nginx) if needed
6. Configure SSL certificates for HTTPS

### Docker Deployment
```dockerfile
FROM node:16-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 5000
CMD ["npm", "start"]
```

## 📝 License

This project is licensed under the ISC License.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📞 Support

For support and questions, please contact the development team or create an issue in the repository.

