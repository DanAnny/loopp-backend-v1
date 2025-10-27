import mongoose from "mongoose";

const ChatRoomSchema = new mongoose.Schema(
  {
    title:   { type: String, default: "" },

    members: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    // link to the request (fast access for meta)
    request: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectRequest" },

    // the assigned PM (your code relies on this existing)
    pm:      { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    isClosed: { type: Boolean, default: false },

    // Live typing map: userId -> role
    typing: { type: Map, of: String, default: {} },

    // Deep-link key (optional)
    roomKey: { type: String, default: null },

    // quick summary for conversation list
    lastMessage: {
      text:   { type: String, default: "" },
      at:     { type: Date, default: null },
      sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },

    // reopen flow
    reopenRequestedByClient: { type: Boolean, default: false },
    reopenRequestedAt:       { type: Date, default: null },
    reopenRequestedBy:       { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

/* ------------ Indexes ------------ */
ChatRoomSchema.index({ roomKey: 1 }, { unique: true, sparse: true, name: "roomKey_1" });
ChatRoomSchema.index({ request: 1 });
ChatRoomSchema.index({ members: 1 });
ChatRoomSchema.index({ pm: 1 });
ChatRoomSchema.index({ updatedAt: -1 }); // list ordering

export const ChatRoom = mongoose.model("ChatRoom", ChatRoomSchema);
