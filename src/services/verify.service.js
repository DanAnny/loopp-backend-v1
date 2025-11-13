import jwt from "jsonwebtoken";
import { config } from "../config/env.js";
import { User } from "../models/User.js";
import { emailSendVerification } from "./email.service.js";

const EMAIL_JWT_SECRET = config?.jwtEmailSecret || (config?.jwtSecret + ".email");
const EXPIRES_HOURS    = Number(config?.emailVerifyHours || 24);

function getProdOrigin() {
  return process.env.FRONTEND_ORIGIN?.trim()
      || config?.frontendUrl
      || "https://loopp-frontend-v1.vercel.app";
}
function getDevOrigin() {
  return process.env.FRONTEND_ORIGIN_DEV?.trim() || "http://localhost:5173";
}

/** Choose the best frontend origin:
 *  - If the incoming request has Origin/Referer pointing at localhost:5173 → use DEV
 *  - Else → use PROD
 */
function pickFrontendOriginFromReq(req) {
  const origin = (req?.get("origin") || req?.headers?.origin || "").toLowerCase();
  const referer = (req?.get("referer") || req?.headers?.referer || "").toLowerCase();

  const looksLocal =
    origin.includes("localhost:5173") ||
    referer.includes("localhost:5173");

  return looksLocal ? getDevOrigin() : getProdOrigin();
}

function buildVerifyUrl(frontendOrigin, token, email) {
  const base = String(frontendOrigin || getProdOrigin());
  const url = new URL(base.includes("http") ? base : `https://${base}`);
  url.pathname = "/verify-email";
  url.searchParams.set("token", token);
  if (email) url.searchParams.set("email", String(email).toLowerCase());
  return url.toString();
}

async function throttleOrMark(userId, windowSec = 60) {
  const now = Date.now();
  const user = await User.findById(userId).select("lastVerifyEmailAt firstName email").lean();
  if (!user) throw new Error("User not found");
  const last = user.lastVerifyEmailAt ? new Date(user.lastVerifyEmailAt).getTime() : 0;
  const diffSec = Math.floor((now - last) / 1000);
  if (diffSec < windowSec) {
    const retryAfterSec = windowSec - diffSec;
    const err = new Error(`Please wait ${retryAfterSec}s before requesting another email`);
    err.code = "THROTTLED";
    err.retryAfterSec = retryAfterSec;
    throw err;
  }
  await User.updateOne({ _id: userId }, { $set: { lastVerifyEmailAt: new Date() } }).catch(() => {});
  return { email: user.email, firstName: user.firstName || "" };
}

/** Accept req to auto-pick dev/prod origin. */
export async function createAndSendVerifyEmail(userDoc, req) {
  const { email, firstName } = await throttleOrMark(userDoc._id, 60);

  const token = jwt.sign(
    { uid: String(userDoc._id), email, t: "email-verify" },
    EMAIL_JWT_SECRET,
    { expiresIn: `${EXPIRES_HOURS}h` }
  );

  const frontendOrigin = pickFrontendOriginFromReq(req);
  const verifyUrl = buildVerifyUrl(frontendOrigin, token, email);

  await emailSendVerification({ to: email, firstName, verifyUrl });
  return { expiresInHours: EXPIRES_HOURS, verifyUrl };
}

export async function consumeVerifyToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, EMAIL_JWT_SECRET);
  } catch {
    const err = new Error("Invalid or expired verification link");
    err.code = "BAD_TOKEN";
    throw err;
  }
  if (!payload?.uid || payload?.t !== "email-verify") {
    const err = new Error("Invalid token payload");
    err.code = "BAD_PAYLOAD";
    throw err;
  }
  const user = await User.findById(payload.uid);
  if (!user) {
    const err = new Error("User not found");
    err.code = "NO_USER";
    throw err;
  }
  if (!user.isVerified) {
    user.isVerified = true;
    await user.save();
  }
  return user;
}
