import * as authService from "../services/auth.service.js";
import * as userService from "../services/user.service.js";
import { fromReq } from "../services/audit.service.js";
import { User } from "../models/User.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { getIO } from "../lib/io.js"; // for socket disconnect
import { config } from "../config/env.js";

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

export const signUpSuperAdmin = async (req, res) => {
  try {
    const { email, password, phone, firstName, lastName, gender } = req.body;
    const user = await authService.registerSuperAdmin(
      email,
      password,
      phone,
      firstName,
      lastName,
      gender
    );
    res.status(201).json({ success: true, message: "SuperAdmin created", user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// ✅ Public client signup (role: Client)
export const signUpClient = async (req, res) => {
  try {
    const { email, password, phone, firstName, lastName, gender } = req.body;

    if (!email || !password || !firstName || !lastName || !phone || !gender) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const user = new User({
      email,
      firstName,
      lastName,
      phone,
      gender,
      role: "Client",
    });

    await User.register(user, password);

    const { accessToken, refreshToken } = await authService.createTokens(user);
    setRefreshCookie(res, refreshToken);

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
      },
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
      user = await authService.addUserBySuperAdmin(
        email, role, phone, firstName, lastName, gender
      );
    } else if (req.user.role === "Admin") {
      user = await userService.adminAddStaff(
        { creator: req.user, email, role, phone, firstName, lastName, gender },
        fromReq(req)
      );
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
  // Ensure Passport 0.6 logout runs BEFORE destroying the session
  const doFinish = async (userIdFromToken) => {
    try {
      const id = userIdFromToken
        ? String(userIdFromToken)
        : (req.user?._id || req.user?.id ? String(req.user._id || req.user.id) : null);

      if (id) {
        // ✅ Hard-offline + token bump so they're instantly ineligible
        await User.updateOne(
          { _id: id },
          {
            $set: {
              online: false,
              lastActive: new Date(0), // ⬅ hard offline to break any recency filters
            },
            $inc: { tokenVersion: 1 },
          }
        );

        // Disconnect sockets for this user (immediate presence update)
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

        // ✅ Nudge the matcher so pending requests won't pick this PM
        try {
          const projectService = await import("../services/project.service.js");
          await projectService.autoAssignFromStandby();
        } catch {}
      }
    } catch {}
  };

  try {
    const token = req.cookies.refreshToken;

    // Revoke refresh token & find the user bound to it
    let userIdFromToken = null;
    if (token) {
      await authService.logoutUser(token);
      const hashed = authService.hashToken(token);
      const stored = await RefreshToken.findOne({ tokenHash: hashed }).lean();
      if (stored?.user) userIdFromToken = stored.user;
    }

    // Clear refresh cookie
    res.clearCookie("refreshToken", {
      path: "/api/auth/refresh",
      secure: true,
      sameSite: "none",
      partitioned: true,
      httpOnly: true,
    });

    // Proper Passport 0.6 logout
    if (typeof req.logout === "function") {
      return req.logout(async (err) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        // Destroy session (if any) AFTER req.logout
        if (req.session && typeof req.session.destroy === "function") {
          req.session.destroy(async () => {
            // Clear session cookie too (optional but nice)
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

    // Fallback: no req.logout (unlikely)
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
