import express from "express";
import authRoutes from "./auth.routes.js";
import projectRoutes from "./project.routes.js";
import taskRoutes from "./task.routes.js";
import chatRoutes from "./chat.routes.js";
import usersRoutes from "./users.routes.js";
import dashboardRoutes from "./dashboard.routes.js";
import fileRoutes from "./file.routes.js";
import managementRoutes from "./management.routes.js";
import notificationRoutes from "./notification.routes.js";
import integrationsRoutes from "./integrations.routes.js";
import devmail from "./dev-mail.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/projects", projectRoutes);
router.use("/tasks", taskRoutes);
router.use("/chat", chatRoutes);
router.use("/users", usersRoutes);
router.use("/dashboard", dashboardRoutes);
router.use("/files", fileRoutes);
router.use("/management", managementRoutes);
router.use("/notifications", notificationRoutes);
router.use("/integrations", integrationsRoutes);
router.use(devmail);

export default router;
