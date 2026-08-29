const bcrypt = require("bcryptjs");
const User = require("./models/User");

async function fixPassword() {
  const user = await User.findOne({ email: "check@gmail.com" });
  if (user) {
    user.password = await bcrypt.hash("1", 10); // Change '1' to the correct password
    await user.save();
    // console.log("Password reset successfully");
  } else {
    console.log("User not found");
  }
}

fixPassword();
