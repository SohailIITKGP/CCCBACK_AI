const app = require("./app");
const { verifySmtpConnection } = require("./utils/smtpTransporter");

const PORT = process.env.PORT || 5000;

if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await verifySmtpConnection();
  });
}

module.exports = app;
