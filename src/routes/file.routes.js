// backend/src/routes/file.routes.js
import express from "express";
import { downloadForMember, downloadForClient } from "../controllers/file.controller.js";

const router = express.Router();

// ⚠️ Unprotected member download route
// e.g. /api/files/:id?download=1
router.get("/:id", downloadForMember);

// client: /api/files/:id/client?requestId=...&clientKey=...&download=1
router.get("/:id/client", downloadForClient);

export default router;
