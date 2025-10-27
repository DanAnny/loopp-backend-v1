import { User } from "../models/User.js";
import { RefreshToken } from "../models/RefreshToken.js";
import {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
} from "../utils/token.utils.js";

/* ------------------------------ SuperAdmin ------------------------------ */
export const registerSuperAdmin = async (email, password, phone, firstName, lastName, gender) => {
  const existing = await User.findOne({ role: "SuperAdmin" });
  if (existing) throw new Error("SuperAdmin already exists");

  const superAdmin = new User({ email, phone, firstName, lastName, gender, role: "SuperAdmin" });
  await User.register(superAdmin, password);
  return superAdmin;
};

export const addUserBySuperAdmin = async (email, role, phone, firstName, lastName, gender) => {
  const user = new User({ email, phone, firstName, lastName, gender, role });
  await User.register(user, phone); // password = phone
  return user;
};

/* --------------------------------- Auth -------------------------------- */
export const authenticateUser = async (email, password) => {
  const { user } = await User.authenticate()(email, password);
  if (!user) throw new Error("Invalid credentials");
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
  await RefreshToken.updateOne({ tokenHash: hashed }, { revoked: true }).catch(() => {});
  if (userId) {
    await User.updateOne(
      { _id: userId },
      { $set: { online: false, lastActive: new Date(0) }, $inc: { tokenVersion: 1 } }
    ).catch(() => {});
  }
};

// re-export for controllers
export { hashToken };
