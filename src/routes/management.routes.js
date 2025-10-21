// routes/management.routes.js
import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authorizeRoles } from "../middleware/role.middleware.js";
import {
  overview,
  bulkUpdateUsers,
  recentAudits,
  quickToggleUser,
} from "../controllers/management.controller.js";

const router = express.Router();

// SuperAdmin and Admin can manage staff (but with role constraints enforced server-side)
router.get("/overview", requireAuth, authorizeRoles("SuperAdmin", "Admin"), overview);
router.get("/audits", requireAuth, authorizeRoles("SuperAdmin", "Admin"), recentAudits);

router.patch(
  "/users/bulk",
  requireAuth,
  authorizeRoles("SuperAdmin", "Admin"),
  bulkUpdateUsers
);

// convenience small update for a single user (busy/online/active only)
router.patch(
  "/users/:id/toggle",
  requireAuth,
  authorizeRoles("SuperAdmin", "Admin"),
  quickToggleUser
);

export default router;
