// src/models/ChatRoom.js
import mongoose from "mongoose";

const ChatRoomSchema = new mongoose.Schema(
  {
    title: String,
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    request: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectRequest" },
    isClosed: { type: Boolean, default: false },

    // Live typing (you already write to it from sockets)
    typing: { type: Map, of: String, default: {} }, // userId -> role

    // 🔑 Deep-linking key
    roomKey: { type: String, default: null }, // optional

    // (optional) quick summary for conversation list
    lastMessage: {
      text: { type: String, default: "" },
      at: { type: Date, default: null },
      sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },

    // ✅ NEW: reopen request from client
    reopenRequestedByClient: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ✅ allow many nulls; only enforce uniqueness when present
ChatRoomSchema.index({ roomKey: 1 }, { unique: true, sparse: true, name: "roomKey_1" });

export const ChatRoom = mongoose.model("ChatRoom", ChatRoomSchema);
