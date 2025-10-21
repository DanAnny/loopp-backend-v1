// backend/src/models/Notification.js
import mongoose from "mongoose";

const NotificationSchema = new mongoose.Schema(
  {
    user:   { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    type:   { type: String, required: true },
    title:  { type: String, required: true },
    body:   { type: String, default: "" },
    link:   { type: String, default: "" },   // SA gets "", others may get /chat etc.
    meta:   { type: Object, default: {} },   // should include requestId and/or taskId
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// 🔒 Only one per (user,type,requestId,taskId)
NotificationSchema.index(
  { user: 1, type: 1, "meta.requestId": 1, "meta.taskId": 1 },
  { unique: true, partialFilterExpression: { "meta.requestId": { $exists: true } } }
);

export const Notification = mongoose.model("Notification", NotificationSchema);
