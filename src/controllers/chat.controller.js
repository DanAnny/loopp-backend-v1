// backend/src/controllers/chat.controller.js
import * as chatService from "../services/chat.service.js";
import { uploadBufferToGridFS } from "../lib/gridfs.js";
import { getIO } from "../lib/io.js";
import { ChatRoom } from "../models/ChatRoom.js";
import { User } from "../models/User.js";
import { ProjectRequest } from "../models/ProjectRequest.js";
import { Message } from "../models/Message.js";
import mongoose from "mongoose";

/* ---------------- helpers to normalize messages ---------------- */
const rolePretty = (r = "") => {
  const s = r.toString();
  if (/client/i.test(s)) return "Client";
  if (/pm|project\s*manager/i.test(s)) return "PM";
  if (/engineer/i.test(s)) return "Engineer";
  if (/admin|super\s*admin/i.test(s)) return "PM";
  return "User";
};
const fullName = (u) =>
  [u?.firstName || u?.first_name, u?.lastName || u?.last_name].filter(Boolean).join(" ");

const shapeMessage = (m, usersById = new Map(), clientEmailFallback = null) => {
  const plain = m.toObject?.() || m;

  // ✅ System first-class: render as System, not as User
  if (plain.senderType === "System") {
    return {
      _id: plain._id,
      room: plain.room,
      sender: null,
      senderType: "System",
      senderRole: "System",
      senderName: "System",
      clientEmail: null,
      text: plain.text || "",
      attachments: [],
      createdAt: plain.createdAt,
      updatedAt: plain.updatedAt,
      visibleTo: plain.visibleTo || "All",
      kind: plain.kind || null,
    };
  }

  let senderRole = "User";
  let senderName = "User";

  if (plain.senderType === "Client") {
    senderRole = "Client";
    senderName = plain.senderName || plain.clientEmail || clientEmailFallback || "Client";
  } else if (plain.sender) {
    const sid = typeof plain.sender === "string"
      ? plain.sender
      : plain.sender?._id?.toString?.();
    const u = usersById.get(sid) || (typeof plain.sender === "object" && plain.sender._id ? plain.sender : null);
    const rolePretty = (r = "") => {
      const s = r.toString();
      if (/client/i.test(s)) return "Client";
      if (/pm|project\s*manager/i.test(s)) return "PM";
      if (/engineer/i.test(s)) return "Engineer";
      if (/admin|super\s*admin/i.test(s)) return "PM";
      return "User";
    };
    const fullName = (u) =>
      [u?.firstName || u?.first_name, u?.lastName || u?.last_name].filter(Boolean).join(" ");

    senderRole = rolePretty(u?.role || plain.senderRole || "User");
    const fromDoc = fullName(u) || u?.name || u?.email?.split?.("@")?.[0] || "";
    senderName = plain.senderName || fromDoc || senderRole;
  }

  return {
    _id: plain._id,
    room: plain.room,
    sender: plain.sender || null,
    senderType: plain.senderType || "User",
    senderRole,
    senderName,
    clientEmail: plain.clientEmail || null,
    text: plain.text || "",
    attachments: Array.isArray(plain.attachments) ? plain.attachments : [],
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    visibleTo: plain.visibleTo || "All",
    kind: plain.kind || null,
  };
};


/* ========================================================================== */
/*                           STAFF / MEMBER ENDPOINTS                         */
/* ========================================================================== */

export const sendMessage = async (req, res) => {
  try {
    const roomId = (req.body?.roomId || "").toString().trim();
    const text = (req.body?.text || "").toString();
    if (!roomId) {
      return res.status(400).json({ success: false, message: "roomId is required" });
    }

    await chatService.ensureMember(roomId, req.user._id, { allowClosed: false });

    const files = Array.isArray(req.files) ? req.files : [];
    const nonEmpty = files.filter((f) => f?.buffer && f.buffer.length > 0);

    let attachments = [];
    if (nonEmpty.length) {
      try {
        attachments = await Promise.all(
          nonEmpty.map((f) =>
            uploadBufferToGridFS({
              buffer: f.buffer,
              filename: f.originalname || "file",
              contentType: f.mimetype || "application/octet-stream",
            })
          )
        );
      } catch (err) {
        return res.status(500).json({ success: false, message: `Upload failed: ${err.message}` });
      }
    }

    if (!text && attachments.length === 0) {
      return res.status(400).json({ success: false, message: "Empty message: provide text or files" });
    }

    const msg = await chatService.postMessage(roomId, req.user, { text, attachments }, { ip: req.ip });

    const u = await User.findById(req.user._id).lean();
    const shaped = shapeMessage({ ...(msg.toObject?.() || msg), sender: u, senderType: "User" });

    getIO()?.to(roomId.toString()).emit("message", shaped);
    return res.status(201).json({ success: true, message: shaped });
  } catch (e) {
    const msg = e?.message || "Failed to send";
    if (/forbidden|not a room member/i.test(msg)) {
      return res.status(403).json({ success: false, message: msg });
    }
    if (/room not found/i.test(msg)) {
      return res.status(404).json({ success: false, message: msg });
    }
    if (/room closed/i.test(msg)) {
      return res.status(423).json({ success: false, message: "Room closed" });
    }
    return res.status(400).json({ success: false, message: msg });
  }
};

export const getMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    const { limit, cursor } = req.query;

    const items = await chatService.getRoomMessages(
      roomId,
      req.user._id,
      Number(limit) || 50,
      cursor || null
    );

    const filtered = items.filter(
      (m) => m.visibleTo !== "Client" && m.senderType !== "System"
    );
    const ids = [
      ...new Set(filtered
        .filter((m) => m.senderType !== "Client" && m.sender)
        .map((m) => m.sender.toString()))
    ];
    const users = await User.find({ _id: { $in: ids } }, "firstName lastName email role").lean();
    const map = new Map(users.map((u) => [u._id.toString(), u]));

    const shaped = filtered.map((m) => shapeMessage(m, map));
    res.json({ success: true, messages: shaped });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const myRooms = async (req, res) => {
  try {
    const rooms = await ChatRoom.find({ members: req.user._id }).sort({ updatedAt: -1 }).lean();
    res.json({ success: true, rooms });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getRoomByKey = async (req, res) => {
  try {
    const { key } = req.params;
    if (!key) return res.status(400).json({ success: false, message: "Missing key" });

    const room = await ChatRoom.findOne({ roomKey: key }).lean();
    if (!room) return res.status(404).json({ success: false, message: "Room not found" });

    const role = (req.user?.role || "").toString();
    const adminBypass = role === "Admin" || role === "SuperAdmin";
    const isMember = room.members?.some?.((m) => m.toString() === req.user._id.toString());

    if (!adminBypass && !isMember) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    res.json({
      success: true,
      room: {
        _id: room._id,
        title: room.title,
        roomKey: room.roomKey,
        members: room.members,
        isClosed: !!room.isClosed,
        request: room.request || null,
        updatedAt: room.updatedAt,
        createdAt: room.createdAt,
      },
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

/* ========================================================================== */
/*                         PUBLIC CLIENT-KEY ENDPOINTS                         */
/* ========================================================================== */

export const clientGetMessages = async (req, res) => {
  try {
    const { requestId } = req.params;
    const clientKey = req.query.clientKey || req.get("x-client-key");
    const limit = Math.min(parseInt(req.query.limit || "100", 10), 200);
    const cursor = req.query.cursor || null;

    if (!clientKey) return res.status(400).json({ success: false, message: "Missing clientKey" });

    const pr = await ProjectRequest.findById(requestId).lean();
    if (!pr) return res.status(404).json({ success: false, message: "Request not found" });
    if (pr.clientKey !== clientKey) return res.status(403).json({ success: false, message: "Invalid key" });

    if (!pr.chatRoom) {
      return res.json({ success: true, messages: [], nextCursor: null });
    }

    const q = { room: pr.chatRoom };
    if (cursor) q._id = { $gt: cursor };

    const msgs = await Message.find(q).sort({ _id: 1 }).limit(limit).lean();
    const nextCursor = msgs.length ? String(msgs[msgs.length - 1]._id) : null;

    const staffIds = [
      ...new Set(msgs.filter((m) => m.senderType !== "Client" && m.sender).map((m) => m.sender.toString())),
    ];
    const staff = await User.find({ _id: { $in: staffIds } }, "firstName lastName email role").lean();
    const map = new Map(staff.map((u) => [u._id.toString(), u]));

    const shaped = msgs.map((m) => shapeMessage(m, map, pr.email));
    res.json({ success: true, messages: shaped, nextCursor });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const clientSendMessage = async (req, res) => {
  try {
    const { requestId, text = "" } = req.body;
    const clientKey = req.body.clientKey || req.get("x-client-key");

    if (!clientKey) return res.status(400).json({ success: false, message: "Missing clientKey" });

    const pr = await ProjectRequest.findById(requestId).lean();
    if (!pr) return res.status(404).json({ success: false, message: "Request not found" });
    if (pr.clientKey !== clientKey) return res.status(403).json({ success: false, message: "Invalid key" });
    if (!pr.chatRoom) return res.status(409).json({ success: false, message: "Chat room not yet available" });

    const files = Array.isArray(req.files) ? req.files : [];
    const nonEmpty = files.filter((f) => f?.buffer && f.buffer.length > 0);

    let attachments = [];
    if (nonEmpty.length) {
      try {
        attachments = await Promise.all(
          nonEmpty.map((f) =>
            uploadBufferToGridFS({
              buffer: f.buffer,
              filename: f.originalname || "file",
              contentType: f.mimetype || "application/octet-stream",
            })
          )
        );
      } catch (err) {
        return res.status(500).json({ success: false, message: `Upload failed: ${err.message}` });
      }
    }

    if (!text && attachments.length === 0) {
      return res.status(400).json({ success: false, message: "Empty message: provide text or files" });
    }

    const msg = await Message.create({
      room: pr.chatRoom,
      senderType: "Client",
      sender: null,
      clientEmail: pr.email || null,
      text,
      attachments,
    });

    const shaped = shapeMessage(
      { ...(msg.toObject?.() || msg), senderType: "Client", clientEmail: pr.email || null },
      new Map(),
      pr.email || null
    );

    try { getIO()?.to(pr.chatRoom.toString()).emit("message", shaped); } catch {}

    res.status(201).json({ success: true, message: shaped });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

/* ========================================================================== */
/*                         CLIENT-AUTH (clientId) ENDPOINTS                   */
/* ========================================================================== */

/**
 * GET /api/chat/my-client-rooms
 * Auth: required (Client user)
 * Lists all projects for this clientId and returns room info.
 * If a PR's chatRoom exists but the client isn't a member yet (legacy),
 * we auto-add them to that room to heal membership.
 */
export const myClientRooms = async (req, res) => {
  try {
    const me = req.user;
    if (!me?._id) return res.status(401).json({ success: false, message: "Unauthorized" });

    const prs = await ProjectRequest.find({ clientId: me._id }).sort({ updatedAt: -1 }).lean();

    const rooms = await Promise.all(
      prs.map(async (p) => {
        let title = p.projectTitle || "Project Chat";
        let updatedAtISO = new Date(p.updatedAt || p.createdAt || Date.now()).toISOString();
        let hasRoom = !!p.chatRoom;
        let isClosed = false;
        let id = `req:${p._id.toString()}`;

        if (p.chatRoom && mongoose.Types.ObjectId.isValid(p.chatRoom)) {
          let r = await ChatRoom.findById(p.chatRoom).lean();

          if (r) {
            // 🔧 Auto-heal: ensure this client is a member of their room
            const isMember = r.members?.some?.((m) => m.toString() === me._id.toString());
            if (!isMember) {
              await ChatRoom.updateOne({ _id: r._id }, { $addToSet: { members: me._id } });
              r = await ChatRoom.findById(p.chatRoom).lean(); // reload members/updatedAt
            }

            id = r._id.toString();
            title = r.title || title;
            isClosed = !!r.isClosed;
            updatedAtISO = new Date(r.updatedAt || updatedAtISO).toISOString();
          }
        }

        return {
          id,
          title,
          hasRoom,
          isClosed,
          updatedAtISO,
          requestId: p._id.toString(),
          clientKey: p.clientKey,
        };
      })
    );

    res.json({ success: true, rooms });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getClientRoomMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(roomId)) {
      return res.status(400).json({ success: false, message: "Invalid room id" });
    }

    const pr = await ProjectRequest.findOne({ chatRoom: roomId, clientId: req.user._id }).lean();
    if (!pr) return res.status(403).json({ success: false, message: "Forbidden" });

    const items = await Message.find({ room: roomId }).sort({ _id: 1 }).limit(300).lean();

    const staffIds = [
      ...new Set(items.filter((m) => m.senderType !== "Client" && m.sender).map((m) => m.sender.toString())),
    ];
    const users = staffIds.length
      ? await User.find({ _id: { $in: staffIds } }, "firstName lastName email role").lean()
      : [];
    const map = new Map(users.map((u) => [u._id.toString(), u]));

    const shaped = items.map((m) => shapeMessage(m, map, pr.email));
    res.json({ success: true, messages: shaped });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const clientRoomSend = async (req, res) => {
  try {
    const roomIdRaw = (req.body?.roomId || "").toString().trim();
    if (!mongoose.Types.ObjectId.isValid(roomIdRaw)) {
      return res.status(400).json({ success: false, message: "Invalid room id (must be 24-hex ObjectId)" });
    }
    const roomId = roomIdRaw;

    const pr = await ProjectRequest.findOne({ chatRoom: roomId, clientId: req.user._id }).lean();
    if (!pr) return res.status(403).json({ success: false, message: "Forbidden" });

    const room = await ChatRoom.findById(roomId).lean();
    if (!room) return res.status(404).json({ success: false, message: "Room not found" });
    if (room.isClosed) return res.status(423).json({ success: false, message: "Room closed" });

    const text = (req.body?.text ?? "").toString();

    const files = Array.isArray(req.files) ? req.files : [];
    const nonEmpty = files.filter((f) => f?.buffer && f.buffer.length > 0);

    let attachments = [];
    if (nonEmpty.length) {
      try {
        attachments = await Promise.all(
          nonEmpty.map((f) =>
            uploadBufferToGridFS({
              buffer: f.buffer,
              filename: f.originalname || "file",
              contentType: f.mimetype || "application/octet-stream",
            })
          )
        );
      } catch (err) {
        return res.status(500).json({ success: false, message: `Upload failed: ${err.message}` });
      }
    }

    if (!text && attachments.length === 0) {
      return res.status(400).json({ success: false, message: "Empty message: provide text or files" });
    }

    const msg = await Message.create({
      room: roomId,
      senderType: "Client",
      sender: null,
      clientEmail: pr.email || null,
      text,
      attachments,
    });

    const shaped = shapeMessage(
      { ...(msg.toObject?.() || msg), senderType: "Client", clientEmail: pr.email || null },
      new Map(),
      pr.email || null
    );

    try { getIO()?.to(roomId.toString()).emit("message", shaped); } catch {}

    return res.status(201).json({ success: true, message: shaped });
  } catch (e) {
    return res.status(400).json({ success: false, message: e?.message || "Bad Request" });
  }
};
