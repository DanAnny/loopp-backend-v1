// backend/src/routes/meetings.routes.js
import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { createGoogleMeetHandler } from "../controllers/meetings.controller.js";

const router = express.Router();

router.post("/google-meet", requireAuth, createGoogleMeetHandler);

export default router;
