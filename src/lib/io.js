// backend/src/lib/io.js
import { Message } from "../models/Message.js";
import { User } from "../models/User.js";
import { autoAssignFromStandby, autoAssignFromStandbyForPM } from "../services/project.service.js";
import { ONLINE_WINDOW_MS } from "../services/pm-selection.service.js";

let ioInstance = null;
export function setIO(io) { ioInstance = io; }
export function getIO() { return ioInstance; }

export const roomKey = {
  all: (roomId) => `${roomId}`,
  clients: (roomId) => `room:${roomId}:clients`,
  pms: (roomId) => `room:${roomId}:pms`,
  engineers: (roomId) => `room:${roomId}:engineers`,
};

/**
 * Persist a client-only system message and emit it LIVE to only the client subgroup
 */
export async function saveAndEmitSystemForClients({ roomId, text, kind = null }) {
  const doc = await Message.create({
    room: roomId,
    senderType: "System",
    text,
    kind,
    visibleTo: "Client",
  });

  const io = getIO();
  if (io) {
    // ⬇️ emit ONLY to client subgroup (PM/Engineer won’t receive)
    io.to(roomKey.clients(roomId)).emit("message", {
      _id: doc._id,
      room: roomId,
      sender: null,
      senderType: "System",
      senderRole: "System",
      senderName: "System",
      text: doc.text,
      attachments: [],
      createdAt: doc.createdAt,
      kind: doc.kind || null,
      visibleTo: "Client",
    });
  }
  return doc;
}

// Backward-compat alias
export async function emitSystemMessage(opts) {
  return saveAndEmitSystemForClients(opts);
}

/* -------------------------------------------------------------------------- */
/*                              Presence & Standby                             */
/* -------------------------------------------------------------------------- */

export function attachPresence(io) {
  const OFFLINE_GRACE_MS = Math.ceil(ONLINE_WINDOW_MS * 1.5);

  io.on("connection", async (socket) => {
    const me = socket.request?.user;
    if (!me) return;

    socket.join(`user:${String(me._id)}`);
    if (me.role) socket.join(`role:${me.role}`);

    // mark online on connect
    try {
      await User.updateOne(
        { _id: me._id },
        { $set: { online: true, lastActive: new Date() } }
      );
    } catch {}

    // if a PM connects, immediately try to auto assign from standby
    if (me.role === "PM") {
      try { await autoAssignFromStandbyForPM(me._id); } catch {}
    }

    // heartbeat
    socket.on("presence:ping", async () => {
      try {
        await User.updateOne(
          { _id: me._id },
          { $set: { online: true, lastActive: new Date() } }
        );
        if (me.role === "PM") {
          await autoAssignFromStandbyForPM(me._id);
        }
      } catch {}
    });

    // soft disconnect; the reaper will flip offline after grace
    socket.on("disconnect", () => {
      try {
        socket.leave(`user:${String(me._id)}`);
        if (me.role) socket.leave(`role:${me.role}`);
      } catch {}
    });
  });

  // Reaper: mark users offline if too quiet
  setInterval(async () => {
    const cutoff = new Date(Date.now() - Math.ceil(ONLINE_WINDOW_MS * 1.5));
    try {
      await User.updateMany(
        { online: true, lastActive: { $lt: cutoff } },
        { $set: { online: false } }
      );
    } catch {}
  }, Math.max(ONLINE_WINDOW_MS, 5000));
}

/** Safety sweeper: very light loop to catch any missed standby assigns */
export function startStandbySweeper() {
  setInterval(async () => {
    try { await autoAssignFromStandby(); } catch {}
  }, 3000);
}
