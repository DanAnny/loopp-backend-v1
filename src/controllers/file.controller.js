import { Types } from "mongoose";
import { streamFileByIdHTTP } from "../lib/gridfs.js";
import { Message } from "../models/Message.js";
import { ChatRoom } from "../models/ChatRoom.js";
import { ProjectRequest } from "../models/ProjectRequest.js";

export const downloadForMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { download } = req.query;

    let fileId;
    try { fileId = new Types.ObjectId(String(id)); }
    catch { return res.status(400).json({ success: false, message: "Bad file id" }); }

    const message = await Message.findOne({ "attachments.fileId": fileId }).lean();
    if (!message) return res.status(404).json({ success: false, message: "Attachment not found" });

    const userId = req.user?._id || req.user?.id; // optional if route is unprotected
    if (userId) {
      const room = await ChatRoom.findById(message.room).lean();
      if (!room) return res.status(404).json({ success: false, message: "Room not found" });
      const isMember = room.members?.some?.((m) => m.toString() === String(userId));
      if (!isMember) return res.status(403).json({ success: false, message: "Forbidden" });
    }

    await streamFileByIdHTTP(req, res, fileId, { asAttachment: download === "1" });
  } catch (e) {
    if (!res.headersSent) res.status(400).json({ success: false, message: e.message });
  }
};

export const downloadForClient = async (req, res) => {
  try {
    const { id } = req.params;
    const { requestId, clientKey, download } = req.query;

    let reqId, fileId;
    try {
      reqId = new Types.ObjectId(String(requestId));
      fileId = new Types.ObjectId(String(id));
    } catch {
      return res.status(400).json({ success: false, message: "Bad id" });
    }

    const request = await ProjectRequest.findById(reqId).lean();
    if (!request || request.clientKey !== clientKey) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    const belongs = await Message.findOne({
      room: request.chatRoom,
      "attachments.fileId": fileId,
    }).lean();
    if (!belongs) return res.status(404).json({ success: false, message: "Attachment not found" });

    await streamFileByIdHTTP(req, res, fileId, { asAttachment: download === "1" });
  } catch (e) {
    if (!res.headersSent) res.status(400).json({ success: false, message: e.message });
  }
};
