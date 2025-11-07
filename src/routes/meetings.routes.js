import express from "express";
import { createZoomMeetingController } from "../controllers/meetings.controller.js";

// If you have existing middlewares:
// import { requireAuth } from "../middlewares/auth.js";
// import { requireRole } from "../middlewares/roles.js";

const router = express.Router();

// POST /meetings/zoom
// Example with guards:
// router.post("/zoom", requireAuth, requireRole(["PM", "Admin", "SuperAdmin"]), createZoomMeetingController);

router.post("/zoom", createZoomMeetingController);

export default router;
