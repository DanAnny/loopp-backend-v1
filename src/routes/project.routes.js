// backend/src/routes/project.routes.js
import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authorizeRoles } from "../middleware/role.middleware.js";
import {
  intakeFromWordPress,
  assignEngineer,
  engineerMarkRequestReview,
  rateRequest,
  pmCloseRequest,
  listProjects,
  getProjectById,
  overview,
  getRoomMeta,
  createFromClient,
  pmReopenRequest,
  engineerAccept,
  getProjectByRoom,
  listProjectsNamed,
  getProjectByIdNamed,
  getProjectByRoomNamed,
  getByClientKey,
  clientRequestReopen, // ✅ NEW
} from "../controllers/project.controller.js";

const router = express.Router();

// intake (consider protecting with shared secret if public)
router.post("/intake", intakeFromWordPress);
router.post("/client/create", requireAuth, createFromClient);

// ✅ client requests reopen (must be authenticated Client)
router.post("/client/request-reopen", requireAuth, clientRequestReopen);

// PUBLIC route should come before "/:id" to avoid shadowing
router.get("/public/by-key/:clientKey", getByClientKey)

// PM/Admin reads
router.get("/", requireAuth, authorizeRoles("PM", "Admin"), listProjects);
router.get("/overview", requireAuth, authorizeRoles("PM", "Admin"), overview);
router.get("/:id", requireAuth, authorizeRoles("PM", "Admin"), getProjectById);

// by-room (PM/Admin) + named variants
router.get("/by-room/:roomId", requireAuth, authorizeRoles("PM", "Admin"), getProjectByRoom);
router.get("/by-room/:roomId/named", requireAuth, authorizeRoles("PM", "Admin"), getProjectByRoomNamed);

// 🔓 OPEN META: no auth, no role checks — always returns minimal meta if room exists
router.get("/by-room/:roomId/meta", getRoomMeta);

// Flow endpoints
router.post("/assign-engineer", requireAuth, authorizeRoles("PM"), assignEngineer);
router.post("/engineer/accept", requireAuth, authorizeRoles("Engineer"), engineerAccept);
router.post("/review", requireAuth, authorizeRoles("Engineer"), engineerMarkRequestReview);
router.post("/rate", rateRequest);
router.post("/close", requireAuth, authorizeRoles("PM"), pmCloseRequest);
router.post("/reopen", requireAuth, authorizeRoles("PM"), pmReopenRequest);

// Named collections
router.get("/named", requireAuth, authorizeRoles("PM", "Admin"), listProjectsNamed);
router.get("/:id/named", requireAuth, authorizeRoles("PM", "Admin"), getProjectByIdNamed);

export default router;
