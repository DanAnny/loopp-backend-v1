// backend/src/config.js
import dotenv from "dotenv";
dotenv.config();

if (!process.env.MONGODB_URI) {
  console.error("❌ Missing MONGODB_URI in .env");
  process.exit(1);
}

export const config = {
  appUrl: process.env.APP_URL || "http://localhost:5173",
  env: process.env.NODE_ENV || "development",
  port: process.env.PORT || 5500,
  mongoURI: process.env.MONGODB_URI,
  corsOrigin: process.env.CORS_ORIGIN,
  smtp: {
    // ⬇️ keep mail disabled by default
    enabled: String(process.env.SMTP_ENABLED || "").toLowerCase() === "true",
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    mailFrom: process.env.MAIL_FROM,
  },
  sessionSecret: process.env.SESSION_SECRET || "fallback-secret",
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    accessExp: process.env.ACCESS_TOKEN_EXP || "15m",
    refreshExp: process.env.REFRESH_TOKEN_EXP || "14d",
  },
};
