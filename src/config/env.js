import dotenv from "dotenv";
dotenv.config();

if (!process.env.MONGODB_URI) {
  console.error("❌ Missing MONGODB_URI in .env");
  process.exit(1);
}

export const config = {
  env: process.env.NODE_ENV || "development",
  port: process.env.PORT || 5500,
  mongoURI: process.env.MONGODB_URI,
  corsOrigin: process.env.CORS_ORIGIN,
  sessionSecret: process.env.SESSION_SECRET || "fallback-secret",
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExp: process.env.ACCESS_TOKEN_EXP || "15m",
    refreshExp: process.env.REFRESH_TOKEN_EXP || "14d",
  },
};
