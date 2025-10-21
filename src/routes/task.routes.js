// backend/src/routes/task.routes.js
import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authorizeRoles } from "../middleware/role.middleware.js";
import {
  createTask,
  acceptTask,
  completeTask,
  listByEngineer,
  summaryByEngineer,
} from "../controllers/task.controller.js";

const router = express.Router();

router.post("/create", requireAuth, authorizeRoles("PM"), createTask);
router.post("/accept", requireAuth, authorizeRoles("Engineer"), acceptTask);
router.post("/complete", requireAuth, authorizeRoles("Engineer"), completeTask);

// NEW: engineer's task list (used by engineer homepage)
router.get(
  "/engineer/:engineerId",
  requireAuth,
  authorizeRoles("Engineer"),
  listByEngineer
);

router.get(
  "/engineer/:engineerId/summary",
  requireAuth,
  authorizeRoles("Engineer"),
  summaryByEngineer
);

export default router;
