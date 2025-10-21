import { AuditLog } from "../models/AuditLog.js";

export const logAudit = async ({
  action, actor=null, target=null, targetModel, request=null, room=null, meta={}, ip, userAgent
}) => {
  try {
    await AuditLog.create({ action, actor, target, targetModel, request, room, meta, ip, userAgent });
  } catch (e) {
    // don't crash the flow if auditing fails
    console.error("Audit error:", e.message);
  }
};

export const fromReq = (req) => ({
  ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress,
  userAgent: req.headers["user-agent"]
});

