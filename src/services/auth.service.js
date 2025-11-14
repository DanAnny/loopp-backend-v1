import { User } from "../models/User.js";
import { RefreshToken } from "../models/RefreshToken.js";
import {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
} from "../utils/token.utils.js";

/* -------------------------- helpers -------------------------- */
function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}

function normalizePhone(phone = "") {
  return String(phone).trim();
}

/* ------------------------------ SuperAdmin ------------------------------ */
export const registerSuperAdmin = async (
  email,
  password,
  phone,
  firstName,
  lastName,
  gender
) => {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);

  // There should only ever be one SuperAdmin
  const existingSuper = await User.findOne({ role: "SuperAdmin" });
  if (existingSuper) throw new Error("SuperAdmin already exists");

  // Extra safety: no duplicate email/phone at all
  const clash = await User.findOne({
    $or: [{ email: normalizedEmail }, { phone: normalizedPhone }],
  }).lean();

  if (clash) {
    if (clash.email === normalizedEmail && clash.phone === normalizedPhone) {
      throw new Error("User with this email and phone already exists");
    } else if (clash.email === normalizedEmail) {
      throw new Error("User with this email already exists");
    } else {
      throw new Error("User with this phone already exists");
    }
  }

  const superAdmin = new User({
    email: normalizedEmail,
    phone: normalizedPhone,
    firstName,
    lastName,
    gender,
    role: "SuperAdmin",
  });

  await User.register(superAdmin, password);
  return superAdmin;
};

export const addUserBySuperAdmin = async (
  email,
  role,
  phone,
  firstName,
  lastName,
  gender
) => {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);

  const clash = await User.findOne({
    $or: [{ email: normalizedEmail }, { phone: normalizedPhone }],
  }).lean();

  if (clash) {
    if (clash.email === normalizedEmail && clash.phone === normalizedPhone) {
      throw new Error("User with this email and phone already exists");
    } else if (clash.email === normalizedEmail) {
      throw new Error("User with this email already exists");
    } else {
      throw new Error("User with this phone already exists");
    }
  }

  const user = new User({
    email: normalizedEmail,
    phone: normalizedPhone,
    firstName,
    lastName,
    gender,
    role,
  });

  // default password = phone
  await User.register(user, normalizedPhone);
  return user;
};

/* --------------------------------- Auth -------------------------------- */

/**
 * Authenticate with clear error messages:
 * - If email doesn't exist → "Email does not exist"
 * - If password is wrong → "Incorrect password"
 * - Otherwise returns the user doc
 */
export const authenticateUser = async (email, password) => {
  const e = normalizeEmail(email);

  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRx.test(e)) {
    throw new Error("Invalid email format");
  }

  // 1) Look up the user first so a non-existent email never reports "wrong password"
  const existing = await User.findOne({ email: e }).exec();
  if (!existing) {
    throw new Error("Email does not exist");
  }

  // 2) Now let passport-local-mongoose validate the password
  const authenticate = User.authenticate();
  const { user, error } = await authenticate(e, password);

  if (!user) {
    if (error) {
      throw new Error("Incorrect password");
    }
    throw new Error("Authentication failed");
  }

  return user;
};

export const createTokens = async (user) => {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken();
  const hashed = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  await RefreshToken.create({ user: user._id, tokenHash: hashed, expiresAt });
  return { accessToken, refreshToken };
};

export const refreshAccessToken = async (token) => {
  const hashed = hashToken(token);
  const stored = await RefreshToken.findOne({ tokenHash: hashed });
  if (!stored || stored.revoked || stored.expiresAt < new Date())
    throw new Error("Invalid or expired refresh token");

  const user = await User.findById(stored.user);
  const newAccess = generateAccessToken(user);
  const newRefresh = generateRefreshToken();
  const newHashed = hashToken(newRefresh);

  stored.revoked = true;
  await stored.save();

  await RefreshToken.create({
    user: user._id,
    tokenHash: newHashed,
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });

  return { accessToken: newAccess, refreshToken: newRefresh };
};

/** Strict offline on logout (revokes RT and flips online=false immediately). */
export const logoutUser = async (token, userId = null) => {
  const hashed = hashToken(token);
  await RefreshToken.updateOne(
    { tokenHash: hashed },
    { revoked: true }
  ).catch(() => {});
  if (userId) {
    await User.updateOne(
      { _id: userId },
      {
        $set: { online: false, lastActive: new Date(0) },
        $inc: { tokenVersion: 1 },
      }
    ).catch(() => {});
  }
};

// re-export for controllers
export { hashToken, normalizeEmail, normalizePhone };
