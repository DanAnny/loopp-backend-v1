import mongoose from "mongoose";

const attachmentSchema = new mongoose.Schema(
  {
    fileId:      { type: mongoose.Schema.Types.ObjectId, required: true },
    filename:    { type: String, required: true },
    contentType: { type: String, required: true },
    length:      { type: Number, required: true },
  },
  { _id: false }
);

const MessageSchema = new mongoose.Schema(
  {
    room: { type: mongoose.Schema.Types.ObjectId, ref: "ChatRoom", required: true },

    senderType: { type: String, enum: ["User", "Client", "System"], default: "User" },

    sender:      { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // when User
    clientEmail: { type: String, lowercase: true },                      // when Client

    text:        { type: String, default: "" },
    attachments: [attachmentSchema],

    // audience control
    visibleTo: { type: String, enum: ["All", "Client", "Staff"], default: "All" },

    // optional classifier for system messages
    kind: { type: String, default: null },
  },
  { timestamps: true }
);

/* ------------ Indexes ------------ */
MessageSchema.index({ room: 1, createdAt: -1 }); // key for fast message lists
MessageSchema.index({ sender: 1, createdAt: -1 });
MessageSchema.index({ kind: 1, room: 1, createdAt: -1 });

export const Message = mongoose.model("Message", MessageSchema);
