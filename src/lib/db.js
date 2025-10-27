// backend/src/lib/db.js
import mongoose from "mongoose";
import { config } from "../config/env.js";

export const connectDB = async () => {
  try {
    await mongoose.connect(config.mongoURI, {
      maxPoolSize: 50,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 8000,
      socketTimeoutMS: 30000,
      heartbeatFrequencyMS: 10000,
    });
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  }
};

// 👉 Add this:
export const ping = async () => {
  if (!mongoose.connection.db) return false;
  return mongoose.connection.db.admin().ping();
};
