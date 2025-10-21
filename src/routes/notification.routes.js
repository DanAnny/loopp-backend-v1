import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { listMyNotifications, markRead, markAllRead } from "../controllers/notification.controller.js";

const router = express.Router();

router.get("/", requireAuth, listMyNotifications);
router.post("/read", requireAuth, markRead);
router.post("/read-all", requireAuth, markAllRead);

export default router;
