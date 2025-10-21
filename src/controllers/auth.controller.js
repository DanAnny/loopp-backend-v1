// src/controllers/auth.controller.js
import * as authService from "../services/auth.service.js";
import * as userService from "../services/user.service.js";
import { fromReq } from "../services/audit.service.js";
import { User } from "../models/User.js";
import { config } from "../config/env.js";

// Helper to set cross-site refresh cookie the SAME way everywhere
function setRefreshCookie(res, token) {
  res.cookie("refreshToken", token, {
    httpOnly: true,
    secure: config.env === "production", // true on Render (HTTPS). For local dev over http, set to false.
    sameSite: "none",                    // required for Vercel ↔ Render cross-site
    path: "/api/auth/refresh",
    maxAge: 14 * 24 * 60 * 60 * 1000,    // 14 days
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

// Public client signup (no role)
export const signUpClient = async (req, res) => {
  try {
    const { email, password, phone, firstName, lastName, gender } = req.body;

    if (!email || !password || !firstName || !lastName || !phone || !gender) {
      return res
        .status(400)
        .json({ success: false, message: "Missing required fields" });
    }

    const user = new User({
      email,
      firstName,
      lastName,
      phone,
      gender,
      role: undefined,
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
        role: user.role || null,
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// SuperAdmin adds any (Admin, PM, Engineer). Admin can add only PM/Engineer.
export const addUser = async (req, res) => {
  try {
    const { email, role, phone, firstName, lastName, gender } = req.body;

    let user;
    if (req.user.role === "SuperAdmin") {
      user = await authService.addUserBySuperAdmin(
        email,
        role,
        phone,
        firstName,
        lastName,
        gender
      );
    } else if (req.user.role === "Admin") {
      user = await userService.adminAddStaff(
        {
          creator: req.user,
          email,
          role,
          phone,
          firstName,
          lastName,
          gender,
        },
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
        role: user.role || null,
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

    const { accessToken, refreshToken } = await authService.refreshAccessToken(
      token
    );

    // rotate cookie
    setRefreshCookie(res, refreshToken);

    res.json({ success: true, accessToken });
  } catch (err) {
    res.status(401).json({ success: false, message: err.message });
  }
};

export const logout = async (req, res) => {
  try {
    const token = req.cookies.refreshToken;
    if (token) await authService.logoutUser(token);

    // clear with same attributes
    res.clearCookie("refreshToken", {
      path: "/api/auth/refresh",
      secure: config.env === "production",
      sameSite: "none",
      httpOnly: true,
    });

    res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};
