import express from "express";
import {
  signUpSuperAdmin, addUser, signIn, refreshToken, logout,
  signUpClient, // ← NEW
} from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authorizeRoles } from "../middleware/role.middleware.js";

const router = express.Router();

router.post("/signup-superadmin", signUpSuperAdmin);

// NEW: public client signup
router.post("/customer/signup", signUpClient);

router.post("/add-user", requireAuth, authorizeRoles("SuperAdmin","Admin"), addUser);
router.post("/signin", signIn);
router.post("/refresh", refreshToken);
router.post("/logout", logout);

export default router;
