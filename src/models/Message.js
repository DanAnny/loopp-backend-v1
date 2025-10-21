import mongoose from "mongoose";

const attachmentSchema = new mongoose.Schema(
  {
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true }, // GridFS _id
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    length: { type: Number, required: true } // bytes
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    room: { type: mongoose.Schema.Types.ObjectId, ref: "ChatRoom", required: true },
    senderType: { type: String, enum: ["User", "Client"], default: "User" },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // when User
    clientEmail: { type: String, lowercase: true }, // when Client
    text: { type: String, default: "" },
    attachments: [attachmentSchema]
  },
  { timestamps: true }
);

export const Message = mongoose.model("Message", messageSchema);
