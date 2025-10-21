import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    action:   { type: String, required: true }, // e.g., USER_CREATED, TASK_ACCEPTED
    actor:    { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // may be null for system/client
    target:   { type: mongoose.Schema.Types.ObjectId, refPath: "targetModel" },
    targetModel: { type: String, enum: ["User", "ProjectRequest", "Task", "ChatRoom", "Message"], required: true },
    request:  { type: mongoose.Schema.Types.ObjectId, ref: "ProjectRequest" },
    room:     { type: mongoose.Schema.Types.ObjectId, ref: "ChatRoom" },
    meta:     { type: Object, default: {} },
    ip:       { type: String },
    userAgent:{ type: String },
  },
  { timestamps: true }
);

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
