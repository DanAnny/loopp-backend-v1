// backend/src/services/chat.service.js
import { ChatRoom } from "../models/ChatRoom.js";
import { Message } from "../models/Message.js";
import { ProjectRequest } from "../models/ProjectRequest.js";
import { logAudit } from "./audit.service.js";
import { getIO } from "../lib/io.js";

/**
 * Ensure a user is a member of the room.
 * By default, closed rooms are NOT allowed (write-protection).
 * Pass { allowClosed: true } to allow access (e.g., for reads).
 */
export const ensureMember = async (roomId, userId, { allowClosed = false } = {}) => {
  const room = await ChatRoom.findById(roomId).lean();
  if (!room) throw new Error("Room not found");
  const isMember = room.members.some((m) => m.toString() === userId.toString());
  if (!isMember) throw new Error("Forbidden: not a room member");
  if (!allowClosed && room.isClosed) throw new Error("Room closed");
  return room;
};

/**
 * Post a message from an authenticated user (PM/Engineer/etc.)
 * - Blocks when room is closed
 */
export const postMessage = async (roomId, senderUser, { text = "", attachments = [] }, auditMeta = {}) => {
  await ensureMember(roomId, senderUser._id, { allowClosed: false });

  const msg = await Message.create({
    room: roomId,
    senderType: "User",
    sender: senderUser._id,
    text,
    attachments,
  });

  await logAudit({
    action: "CHAT_MESSAGE",
    actor: senderUser._id,
    target: msg._id,
    targetModel: "Message",
    room: roomId,
    meta: { textLength: text?.length || 0, attachmentsCount: attachments?.length || 0, ...auditMeta },
  });

  // personal notifications (optional)
  try {
    const room = await ChatRoom.findById(roomId).lean();
    const io = getIO();
    for (const mid of room?.members || []) {
      if (String(mid) === String(senderUser._id)) continue;
      io?.to(`user:${mid.toString()}`).emit("notify:message", {
        roomId,
        preview: text?.slice(0, 100) || "New message",
        at: msg.createdAt,
      });
    }
  } catch (_) {}

  return msg;
};

/**
 * Get messages (authenticated user)
 * - Allows reads even when room is closed
 */
export async function getRoomMessages(roomId, userId, limit = 50, cursor = null) {
  await ensureMember(roomId, userId, { allowClosed: true });

  const q = { room: roomId };
  if (cursor) q._id = { $lt: cursor };

  // Projection = only what UI needs; pairs with {room:1,_id:-1} index
  const docs = await Message
    .find(q, {
      _id: 1,
      room: 1,
      sender: 1,
      senderType: 1,
      text: 1,
      attachments: 1,
      createdAt: 1,
      visibleTo: 1,
      kind: 1,
      allowRating: 1,
      meta: 1,
    })
    .sort({ _id: -1 })
    .limit(Math.max(1, Math.min(200, limit)))
    .lean();

  return docs.reverse();
}

/* -------------------------- Client via clientKey -------------------------- */

/**
 * Client posting a message (public via clientKey)
 * - Blocks when room is closed
 */
export const clientPost = async ({ requestId, clientKey, text = "", attachments = [] }, auditMeta = {}) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req || req.clientKey !== clientKey) throw new Error("Unauthorized client");
  if (!req.chatRoom) throw new Error("Room not ready");

  const room = await ChatRoom.findById(req.chatRoom).lean();
  if (!room) throw new Error("Room not found");
  if (room.isClosed) throw new Error("Room closed");

  const msg = await Message.create({
    room: req.chatRoom,
    senderType: "Client",      // ← explicit
    sender: null,
    clientEmail: req.email || null,
    text,
    attachments,
  });

  await logAudit({
    action: "CHAT_MESSAGE_CLIENT",
    actor: null,
    target: msg._id,
    targetModel: "Message",
    request: req._id,
    room: req.chatRoom,
    meta: { clientEmail: req.email, textLength: text?.length || 0, attachmentsCount: attachments?.length || 0, ...auditMeta },
  });

  return msg;
};

/**
 * Client fetching messages (public via clientKey)
 * - Always allowed if clientKey matches (read-only even when closed)
 */
export const clientFetch = async ({ requestId, clientKey, limit = 50, cursor = null }) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req || req.clientKey !== clientKey) throw new Error("Unauthorized client");
  if (!req.chatRoom) throw new Error("Room not ready");

  const query = { room: req.chatRoom };
  if (cursor) query._id = { $lt: cursor };

  // Match the same projection as authenticated reads for speed + consistency
  const items = await Message
    .find(query, {
      _id: 1,
      room: 1,
      sender: 1,
      senderType: 1,
      text: 1,
      attachments: 1,
      createdAt: 1,
      visibleTo: 1,
      kind: 1,
      allowRating: 1,
      meta: 1,
    })
    .sort({ _id: -1 })
    .limit(Math.max(1, Math.min(200, limit)))
    .lean();

  return items.reverse();
};
