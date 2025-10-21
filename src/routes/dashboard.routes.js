import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authorizeRoles } from "../middleware/role.middleware.js";
import { overview } from "../controllers/dashboard.controller.js";

const router = express.Router();

router.get("/overview", requireAuth, authorizeRoles("SuperAdmin", "Admin"), overview);

export default router;
