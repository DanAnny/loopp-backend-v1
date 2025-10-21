import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { authorizeRoles } from "../middleware/role.middleware.js";
import { getAll, getEngineers, getPMs } from "../controllers/users.controller.js";

const router = express.Router();

router.get("/engineers", requireAuth, authorizeRoles("PM","Admin","SuperAdmin"), getEngineers);
router.get("/pms",       requireAuth, authorizeRoles("Admin","SuperAdmin"), getPMs);
router.get("/",    requireAuth, authorizeRoles("PM","Admin","SuperAdmin"), getAll);

export default router;
