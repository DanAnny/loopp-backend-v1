// backend/src/controllers/auth.controller.js
import * as authService from "../services/auth.service.js";
import * as userService from "../services/user.service.js";
import { fromReq } from "../services/audit.service.js";
import { User } from "../models/User.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { getIO } from "../lib/io.js";
import { config } from "../config/env.js";
import { createAndSendVerifyEmail, consumeVerifyToken } from "../services/verify.service.js";

// Helper to set cross-site refresh cookie the SAME way everywhere
function setRefreshCookie(res, token) {
  res.cookie("refreshToken", token, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    partitioned: true,
    path: "/api/auth/refresh",
    maxAge: 14 * 24 * 60 * 60 * 1000,
  });
}

// ---------- NEW: /auth/me ----------
export async function me(req, res) {
  try {
    const user = await User.findById(req.user?._id || req.user?.id || req.userId).lean();
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.json({
      success: true,
      user: {
        _id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        gender: user.gender,
        role: user.role,
        isVerified: !!user.isVerified,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || "Failed to load profile" });
  }
}

export const signUpSuperAdmin = async (req, res) => {
  try {
    const { email, password, phone, firstName, lastName, gender } = req.body;
    const user = await authService.registerSuperAdmin(
      email, password, phone, firstName, lastName, gender
    );
    res.status(201).json({ success: true, message: "SuperAdmin created", user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// ✅ Public client signup (role: Client)
// Sends a verification email immediately after creating tokens.
export const signUpClient = async (req, res) => {
  try {
    const { email, password, phone, firstName, lastName, gender } = req.body;
    if (!email || !password || !firstName || !lastName || !phone || !gender) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const user = new User({ email, firstName, lastName, phone, gender, role: "Client", isVerified: false });
    await User.register(user, password);

    const { accessToken, refreshToken } = await authService.createTokens(user);
    setRefreshCookie(res, refreshToken);

    // Send verification email ONCE here (auto-picks dev/prod from req)
    let expiresInHours = null;
    try {
      const out = await createAndSendVerifyEmail(user, req);
      expiresInHours = out?.expiresInHours ?? null;
    } catch { /* swallow */ }

    return res.status(201).json({
      success: true,
      accessToken,
      user: {
        _id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        gender: user.gender,
        role: user.role,
        isVerified: !!user.isVerified,
      },
      verification: { sent: true, expiresInHours },
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

export const addUser = async (req, res) => {
  try {
    const { email, role, phone, firstName, lastName, gender } = req.body;

    let user;
    if (req.user.role === "SuperAdmin") {
      user = await authService.addUserBySuperAdmin(email, role, phone, firstName, lastName, gender);
    } else if (req.user.role === "Admin") {
      user = await userService.adminAddStaff({ creator: req.user, email, role, phone, firstName, lastName, gender }, fromReq(req));
    } else {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    res.status(201).json({ success: true, message: "User added", user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

export const signIn = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await authService.authenticateUser(email, password);
    const { accessToken, refreshToken } = await authService.createTokens(user);
    setRefreshCookie(res, refreshToken);

    res.json({
      success: true,
      accessToken,
      user: {
        _id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        gender: user.gender,
        role: user.role || "Client",
        isVerified: !!user.isVerified,
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

export const refreshToken = async (req, res) => {
  try {
    const token = req.cookies.refreshToken;
    if (!token) throw new Error("No refresh token provided");

    const { accessToken, refreshToken } = await authService.refreshAccessToken(token);
    setRefreshCookie(res, refreshToken);
    res.json({ success: true, accessToken });
  } catch (err) {
    res.status(401).json({ success: false, message: err.message });
  }
};

export const logout = async (req, res) => {
  const doFinish = async (userIdFromToken) => {
    try {
      const id = userIdFromToken
        ? String(userIdFromToken)
        : (req.user?._id || req.user?.id ? String(req.user._id || req.user.id) : null);

      if (id) {
        await User.updateOne(
          { _id: id },
          { $set: { online: false, lastActive: new Date(0) }, $inc: { tokenVersion: 1 } }
        );

        const io = getIO();
        if (io) {
          const ns = io.of("/");
          for (const [, sock] of ns.sockets) {
            const sockUid = sock.handshake?.auth?.userId || sock.handshake?.query?.userId;
            if (String(sockUid || "") === id) {
              try { sock.disconnect(true); } catch {}
            }
          }
        }

        try {
          const projectService = await import("../services/project.service.js");
          await projectService.autoAssignFromStandby();
        } catch {}
      }
    } catch {}
  };

  try {
    const token = req.cookies.refreshToken;

    let userIdFromToken = null;
    if (token) {
      await authService.logoutUser(token);
      const hashed = authService.hashToken(token);
      const stored = await RefreshToken.findOne({ tokenHash: hashed }).lean();
      if (stored?.user) userIdFromToken = stored.user;
    }

    res.clearCookie("refreshToken", {
      path: "/api/auth/refresh",
      secure: true,
      sameSite: "none",
      partitioned: true,
      httpOnly: true,
    });

    if (typeof req.logout === "function") {
      return req.logout(async (err) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (req.session && typeof req.session.destroy === "function") {
          req.session.destroy(async () => {
            res.clearCookie("connect.sid", {
              path: "/",
              httpOnly: true,
              sameSite: "none",
              secure: config.env === "production",
            });
            await doFinish(userIdFromToken);
            return res.json({ success: true, message: "Logged out successfully" });
          });
        } else {
          await doFinish(userIdFromToken);
          return res.json({ success: true, message: "Logged out successfully" });
        }
      });
    }

    if (req.session && typeof req.session.destroy === "function") {
      req.session.destroy(async () => {
        res.clearCookie("connect.sid", {
          path: "/",
          httpOnly: true,
          sameSite: "none",
          secure: config.env === "production",
        });
        await doFinish(userIdFromToken);
        return res.json({ success: true, message: "Logged out successfully" });
      });
    } else {
      await doFinish(userIdFromToken);
      return res.json({ success: true, message: "Logged out successfully" });
    }
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// ---------- Email verification endpoints ----------
export async function resendVerifyEmail(req, res) {
  // We’ll reuse sendVerifyEmail (same throttling). If you want a different policy, you can add a `force` flag in the service.
  return sendVerifyEmail(req, res);
}

export async function sendVerifyEmail(req, res) {
  try {
    const userId = req.user?._id || req.user?.id || req.userId;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    if (user.isVerified) return res.json({ success: true, message: "Already verified" });

    // Auto-pick dev/prod link based on req (Origin/Referer)
    const out = await createAndSendVerifyEmail(user, req);
    res.json({ success: true, message: "Verification email sent", expiresInHours: out?.expiresInHours ?? null });
  } catch (e) {
    if (e?.code === "THROTTLED") {
      return res.status(429).json({ success: false, message: e.message, retryAfterSec: e.retryAfterSec });
    }
    res.status(500).json({ success: false, message: e.message || "Failed to send verification" });
  }
}

export async function consumeVerify(req, res) {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ success: false, message: "Token required" });
    const user = await consumeVerifyToken(token);
    res.json({ success: true, email: user.email });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message || "Verification failed" });
  }
}

export async function verifyStatus(req, res) {
  try {
    const email = String(req.query.email || "").toLowerCase().trim();
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ success: false, message: "Not found" });
    res.json({ success: true, isVerified: !!user.isVerified });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}
