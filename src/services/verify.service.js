import crypto from "crypto";
import { config } from "../config/env.js";
import { User } from "../models/User.js";
import { emailSendVerification } from "./email.service.js";

const OTP_TTL_MIN = 2; // 2 minutes
const OTP_TTL_MS = OTP_TTL_MIN * 60 * 1000;

function hashOtp(code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

async function throttleOrMark(userId, windowSec = 60) {
  const now = Date.now();
  const user = await User.findById(userId).select(
    "lastVerifyEmailAt firstName email"
  ).lean();
  if (!user) throw new Error("User not found");

  const last = user.lastVerifyEmailAt
    ? new Date(user.lastVerifyEmailAt).getTime()
    : 0;
  const diffSec = Math.floor((now - last) / 1000);

  if (diffSec < windowSec) {
    const retryAfterSec = windowSec - diffSec;
    const err = new Error(
      `Please wait ${retryAfterSec}s before requesting another code`
    );
    err.code = "THROTTLED";
    err.retryAfterSec = retryAfterSec;
    throw err;
  }

  await User.updateOne(
    { _id: userId },
    { $set: { lastVerifyEmailAt: new Date() } }
  ).catch(() => {});
  return { email: user.email, firstName: user.firstName || "" };
}

/**
 * Generates a 6-digit OTP, stores its hash + 2-minute expiry on the user,
 * and emails the code.
 */
export async function createAndSendVerifyEmail(userDoc, req) {
  const { email, firstName } = await throttleOrMark(userDoc._id, 60);

  // 6-digit code
  const code = (Math.floor(100000 + Math.random() * 900000)).toString();

  const otpHash = hashOtp(code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await User.updateOne(
    { _id: userDoc._id },
    {
      $set: {
        emailVerifyOtpHash: otpHash,
        emailVerifyOtpExpiresAt: expiresAt,
      },
    }
  );

  await emailSendVerification({
    to: email,
    firstName,
    code,
    expiresInMinutes: OTP_TTL_MIN,
  });

  return { expiresInMinutes: OTP_TTL_MIN };
}

/**
 * Verifies the OTP for a given email.
 * If valid + not expired, marks user as verified and clears OTP.
 */
export async function consumeVerifyToken(code, email) {
  const cleanEmail = String(email || "").toLowerCase().trim();
  const cleanCode = String(code || "").trim();

  if (!cleanEmail || !cleanCode) {
    const err = new Error("Email and code are required");
    err.code = "MISSING";
    throw err;
  }

  const user = await User.findOne({ email: cleanEmail });
  if (!user) {
    const err = new Error("User not found");
    err.code = "NO_USER";
    throw err;
  }

  if (!user.emailVerifyOtpHash || !user.emailVerifyOtpExpiresAt) {
    const err = new Error("No active verification code. Please request a new one.");
    err.code = "NO_OTP";
    throw err;
  }

  const now = Date.now();
  const exp = new Date(user.emailVerifyOtpExpiresAt).getTime();
  if (exp < now) {
    const err = new Error("Verification code has expired");
    err.code = "EXPIRED";
    throw err;
  }

  const incomingHash = hashOtp(cleanCode);
  if (incomingHash !== user.emailVerifyOtpHash) {
    const err = new Error("Invalid verification code");
    err.code = "BAD_CODE";
    throw err;
  }

  // Mark verified + clear OTP
  user.isVerified = true;
  user.emailVerifyOtpHash = undefined;
  user.emailVerifyOtpExpiresAt = undefined;
  await user.save();

  return user;
}
