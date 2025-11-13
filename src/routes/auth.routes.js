// backend/src/routes/auth.routes.js
import express from "express";
import {
  signUpSuperAdmin, addUser, signIn, refreshToken, logout,
  signUpClient,
  me,
  sendVerifyEmail, resendVerifyEmail, consumeVerify, verifyStatus,
} from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authorizeRoles } from "../middleware/role.middleware.js";

const router = express.Router();

router.post("/signup-superadmin", signUpSuperAdmin);

// Public client signup
router.post("/customer/signup", signUpClient);

router.post("/add-user", requireAuth, authorizeRoles("SuperAdmin","Admin"), addUser);
router.post("/signin", signIn);
router.post("/refresh", refreshToken);
router.post("/logout", logout);

// Profile
router.get("/me", requireAuth, me);

// Verification
router.post("/verify/send", requireAuth, sendVerifyEmail);
router.post("/verify/resend", requireAuth, resendVerifyEmail);
router.post("/verify/consume", consumeVerify);
router.get("/verify/status", verifyStatus);

export default router;
