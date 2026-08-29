const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");


const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    password: { type: String, required: true },
    assignedClients: [{ type: mongoose.Schema.Types.ObjectId, ref: "Client" }],
    role: {
      type: String,
      enum: ["Super Admin", "Manager", "FE-Property", "BO-Client", "BO-Lead"  , "Lead-Employee" , "Product-Manager"],
      default: "BO-Lead",
    },
    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
    profilePicture: {
      type: String,
      default: "",
      },
    city: {
      type: String,
      default: "",
      },  
      propertyCreadted: [{ type: mongoose.Schema.Types.ObjectId, ref: "Property" }],  
      leadassign: [{ type: mongoose.Schema.Types.ObjectId, ref: "Lead" }],
      deviceTokens: [{ type: String }]
  },
  
  { timestamps: true }
);

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

module.exports = mongoose.model("User", userSchema);
