const mongoose = require("mongoose");

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

/** Reuse connection across warm serverless invocations. */
let cached = global.__mongooseCache;
if (!cached) {
  cached = global.__mongooseCache = { conn: null, promise: null };
}

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    const message = "MONGO_URI is not set";
    console.error(`[db] ${message}`);
    if (isServerless) {
      throw new Error(message);
    }
    process.exit(1);
  }

  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(process.env.MONGO_URI, {
        maxPoolSize: isServerless ? 5 : 20,
        serverSelectionTimeoutMS: isServerless ? 10000 : 5000,
        socketTimeoutMS: 45000,
        writeConcern: {
          w: 1,
          j: false,
          wtimeout: 1000,
        },
      })
      .then((conn) => {
        console.log("MongoDB Connected:");
        return conn;
      })
      .catch((error) => {
        cached.promise = null;
        console.error(`[db] connect failed: ${error.message}`);
        if (isServerless) {
          throw error;
        }
        process.exit(1);
        return null;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
};

module.exports = connectDB;
