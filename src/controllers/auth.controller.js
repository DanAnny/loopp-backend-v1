import * as authService from "../services/auth.service.js";
import * as userService from "../services/user.service.js";
import { fromReq } from "../services/audit.service.js";
import { User } from "../models/User.js"; // ← for client signup via passport-local-mongoose

export const signUpSuperAdmin = async (req, res) => {
  try {
    const { email, password, phone, firstName, lastName, gender } = req.body;
    const user = await authService.registerSuperAdmin(email, password, phone, firstName, lastName, gender);
    res.status(201).json({ success: true, message: "SuperAdmin created", user });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};

// NEW: public client signup (no role)
export const signUpClient = async (req, res) => {
  try {
    const { email, password, phone, firstName, lastName, gender } = req.body;

    if (!email || !password || !firstName || !lastName || !phone || !gender) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // passport-local-mongoose:
    const user = new User({
      email,
      firstName,
      lastName,
      phone,
      gender,       // 'Male' | 'Female'
      role: undefined, // explicitly no role for clients
    });

    await User.register(user, password);

    // issue tokens same as signIn
    const { accessToken, refreshToken } = await authService.createTokens(user);

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/auth/refresh",
      maxAge: 14 * 24 * 60 * 60 * 1000,
    });

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
      user = await authService.addUserBySuperAdmin(email, role, phone, firstName, lastName, gender);
    } else if (req.user.role === "Admin") {
      user = await userService.adminAddStaff({ creator: req.user, email, role, phone, firstName, lastName, gender }, fromReq(req));
    } else {
      return res.status(403).json({ success:false, message:"Forbidden" });
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
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true, secure: process.env.NODE_ENV === "production",
      sameSite: "lax", path: "/api/auth/refresh", maxAge: 14*24*60*60*1000,
    });
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
      }
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
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true, secure: process.env.NODE_ENV === "production",
      sameSite: "lax", path: "/api/auth/refresh", maxAge: 14*24*60*60*1000,
    });
    res.json({ success: true, accessToken });
  } catch (err) {
    res.status(401).json({ success: false, message: err.message });
  }
};

export const logout = async (req, res) => {
  try {
    const token = req.cookies.refreshToken;
    if (token) await authService.logoutUser(token);
    res.clearCookie("refreshToken", { path: "/api/auth/refresh" });
    res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
};
