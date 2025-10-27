// index.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import session from "express-session";
import MongoStore from "connect-mongo";
import passport from "passport";
import createError from "http-errors";
import http from "http";
import compression from "compression";
import helmet from "helmet";
import { Server as SocketIOServer } from "socket.io";
import { setIO, roomKey /*, saveAndEmitSystemForClients*/ } from "./src/lib/io.js";
import path from "path";
import { fileURLToPath } from "url";

import { config } from "./src/config/env.js";
import { connectDB } from "./src/lib/db.js";
import "./src/lib/passport.js";
import routes from "./src/routes/index.js";
import { ChatRoom } from "./src/models/ChatRoom.js";
import { Message } from "./src/models/Message.js";
import { User } from "./src/models/User.js";
import { initGridFS } from "./src/lib/gridfs.js";
import * as projectService from "./src/services/project.service.js";
import { ONLINE_WINDOW_MS } from "./src/services/pm-selection.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// ---------- HTTP server tuning ----------
server.keepAliveTimeout = 75_000;
server.headersTimeout   = 90_000;

const ALLOWLIST = [
  "http://localhost:5173",
  "https://loopp-frontend-v1.vercel.app",
  "https://loopp.com",
];

app.set("env", config.env);
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ---------- Security + gzip ----------
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression({ threshold: 1024 }));

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWLIST.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// ---------- Light middleware ----------
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
if (config.env !== "production") app.use(morgan("dev"));

app.use(
  "/uploads",
  express.static(path.resolve(__dirname, "uploads"), { maxAge: "1h", etag: true })
);

// ---------- Session store (less churn) ----------
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: config.mongoURI,
      collectionName: "sessions",
      ttl: 60 * 60 * 24 * 14,
      touchAfter: 24 * 3600,
    }),
    cookie: {
      httpOnly: true,
      secure: config.env === "production",
      sameSite: "none",
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
    name: "sid",
  })
);

app.use(passport.initialize());
app.use(passport.session());

// ---------- DB connect, gridfs ----------
await connectDB();
initGridFS();

// ---------- Background maintenance (non-blocking) ----------
(async () => {
  try {
    await User.updateMany(
      {
        online: true,
        $or: [
          { lastActive: { $exists: false } },
          { lastActive: { $lt: new Date(Date.now() - ONLINE_WINDOW_MS) } },
        ],
      },
      { $set: { online: false } }
    ).catch(() => {});
  } catch {}

  try {
    await Promise.allSettled([
      (await import("./src/models/User.js")).User.syncIndexes(),
      (await import("./src/models/ChatRoom.js")).ChatRoom.syncIndexes(),
      (await import("./src/models/Message.js")).Message.syncIndexes(),
      (await import("./src/models/ProjectRequest.js")).ProjectRequest.syncIndexes(),
      (await import("./src/models/Notification.js")).Notification.syncIndexes(),
      (await import("./src/models/Task.js")).Task.syncIndexes(),
      (await import("./src/models/RefreshToken.js")).RefreshToken.syncIndexes(),
    ]);
  } catch {}
})();

// ---------- Routes ----------
app.use("/api", routes);
app.get("/", (_req, res) => res.send("✅ API up"));

app.use((_, __, next) => next(createError(404, "Not Found")));
app.use((err, _req, res, __) =>
  res.status(err.status || 500).json({ success: false, message: err.message })
);

// ---------- Socket.IO ----------
const io = new SocketIOServer(server, {
  transports: ["websocket"],
  pingInterval: 20_000,
  pingTimeout: 20_000,
  cors: { origin: ALLOWLIST, credentials: true },
});
setIO(io);

// ======== FAST PATH: single-flight assignment scheduler ========
const assignScheduler = {
  running: false,
  queued: false,
  lastRunAt: 0,
  minGapMs: 600,
};

async function runAssignOnce() {
  try {
    await projectService.autoAssignFromStandby();
  } catch {}
}

function scheduleAssign() {
  const now = Date.now();
  if (assignScheduler.running) {
    assignScheduler.queued = true;
    return;
  }
  if (now - assignScheduler.lastRunAt < assignScheduler.minGapMs) {
    if (!assignScheduler._timer) {
      const delay = assignScheduler.minGapMs - (now - assignScheduler.lastRunAt);
      assignScheduler._timer = setTimeout(() => {
        assignScheduler._timer = null;
        scheduleAssign();
      }, Math.max(0, delay));
    }
    return;
  }

  assignScheduler.running = true;
  assignScheduler.lastRunAt = now;

  queueMicrotask(async () => {
    try {
      await runAssignOnce();
    } finally {
      assignScheduler.running = false;
      if (assignScheduler.queued) {
        assignScheduler.queued = false;
        scheduleAssign();
      }
    }
  });
}

// Presence bookkeeping
const FORCE_LOGOUT_IDLE_MS = 5 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = Math.min(ONLINE_WINDOW_MS, 5000);
let presenceSweepRunning = false;

const presenceCount = new Map();
const lastSeenActive = new Map();
const userSockets = new Map();
const socketOwners = new Map();

async function markUserActive(userId) {
  if (!userId) return;
  const now = Date.now();
  lastSeenActive.set(userId, now);
  if ((presenceCount.get(userId) || 0) > 0) {
    User.updateOne({ _id: userId }, { $set: { online: true, lastActive: new Date(now) } }).catch(() => {});
  }
}
async function markUserOffline(userId) {
  if (!userId) return;
  User.updateOne({ _id: userId }, { $set: { online: false, lastActive: new Date() } }).catch(() => {});
}
async function forceLogoutUser(userId) {
  if (!userId) return;
  User.updateOne(
    { _id: userId },
    { $inc: { tokenVersion: 1 }, $set: { online: false, lastActive: new Date(0) } }
  ).catch(() => {});
  io.to(`user:${userId}`).emit("auth:force_logout", { reason: "idle_timeout", at: new Date().toISOString() });
  const sockets = userSockets.get(userId);
  if (sockets && sockets.size) {
    for (const sid of sockets) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) { try { sock.disconnect(true); } catch {} }
    }
  }
}

// Throttled sweep (never overlap)
setInterval(async () => {
  if (presenceSweepRunning) return;
  presenceSweepRunning = true;
  const now = Date.now();
  try {
    await User.updateMany(
      { online: true, lastActive: { $lt: new Date(now - ONLINE_WINDOW_MS) } },
      { $set: { online: false } }
    ).catch(() => {});
    for (const [userId, last] of lastSeenActive.entries()) {
      if (now - last >= FORCE_LOGOUT_IDLE_MS) {
        await forceLogoutUser(userId);
        presenceCount.delete(userId);
        lastSeenActive.delete(userId);
        userSockets.delete(userId);
      }
    }
  } finally {
    presenceSweepRunning = false;
  }
}, IDLE_SWEEP_INTERVAL_MS);

// Lightweight periodic nudge (uses scheduler; doesn't block)
setInterval(() => scheduleAssign(), 4000);

io.on("connection", (socket) => {
  const rawId = socket.handshake?.auth?.userId || socket.handshake?.query?.userId || null;
  const userId = rawId ? String(rawId) : null;
  let myUserDoc = null;

  socketOwners.set(socket.id, userId);
  if (userId) {
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);
  }

  (async () => {
    if (!userId) return;
    try { myUserDoc = await User.findById(userId).lean(); } catch {}
    socket.join(`user:${userId}`);

    const count = (presenceCount.get(userId) || 0) + 1;
    presenceCount.set(userId, count);
    await markUserActive(userId);

    // Only thing we broadcast as inline presence: PM is actively online
    if (myUserDoc?.role === "PM") {
      io.to(`user:${userId}`).emit("system", {
        type: "pm_online",
        userId,
        role: "PM",
        timestamp: new Date().toISOString(),
      });
      // PM online -> attempt assignment (non-blocking)
      scheduleAssign();
    }
  })();

  // ⚡ non-blocking: schedule, don't await
  socket.on("auth:logout", () => {
    const uid = socketOwners.get(socket.id);
    if (!uid) return;
    User.updateOne(
      { _id: uid },
      { $set: { online: false, lastActive: new Date(0) }, $inc: { tokenVersion: 1 } }
    ).catch(() => {});
    try { socket.disconnect(true); } catch {}
    scheduleAssign();
  });

  socket.on("presence:active", async () => {
    const uid = socketOwners.get(socket.id);
    if (uid) await markUserActive(uid);
    scheduleAssign();
  });

  socket.on("join", async ({ roomId, userId: uid }) => {
    try {
      const room = await ChatRoom.findById(roomId).lean();
      if (!room) return socket.emit("error", "Room not found");

      // Join room scopes (no extra banners)
      socket.join(roomKey.all(roomId));
      socket.emit("joined", roomId);
      if (uid) socket.join(`user:${String(uid)}`);

      const u = (uid && (await User.findById(uid).lean())) || {};
      const role = (u?.role || "User").toString();
      if (/client/i.test(role)) socket.join(roomKey.clients(roomId));
      else if (/pm|project\s*manager/i.test(role)) socket.join(roomKey.pms(roomId));
      else if (/engineer/i.test(role)) socket.join(roomKey.engineers(roomId));

      if (uid) await markUserActive(String(uid));

      // ----- NO "pm_assigned" inline banner -----
      // We still ensure exactly-one welcome message using an atomic upsert:
      // await saveAndEmitSystemForClients(
      //   io,
      //   roomId,
      //   `Welcome ${u?.firstName || "User"}! An engineer will be with you shortly.`,
      //   "welcome_message"
      // );
      // We do NOT emit: join/leave banners, engineer_online, "pm_assigned" inline, etc.
    } catch (e) {
      socket.emit("error", e.message);
    }
  });

  socket.on("typing", async ({ roomId, userId: uid, role, isTyping }) => {
    try {
      const room = await ChatRoom.findById(roomId);
      if (!room) return;
      if (uid) await markUserActive(String(uid));

      if (isTyping) room.typing.set(String(uid), role || "User");
      else room.typing.delete(String(uid));
      await room.save();

      socket.to(roomKey.all(roomId)).emit("typing", { roomId, userId: uid, role, isTyping });
    } catch {}
  });

  socket.on("message", async ({ roomId, userId: uid, text = "", attachments = [] }) => {
    try {
      const room = await ChatRoom.findById(roomId).lean();
      if (!room) return socket.emit("error", "Room not found");

      const u = (uid && (await User.findById(uid).lean())) || null;
      if (uid) await markUserActive(String(uid));

      const msg = await Message.create({
        room: roomId,
        senderType: "User",
        sender: uid,
        text,
        attachments,
      });

      io.to(roomKey.all(roomId)).emit("message", {
        _id: msg._id,
        room: roomId,
        sender: uid,
        senderType: "User",
        senderRole: u?.role || "User",
        senderName: [u?.firstName, u?.lastName].filter(Boolean).join(" ") || "User",
        text,
        attachments,
        createdAt: msg.createdAt,
      });
    } catch (e) {
      socket.emit("error", e.message);
    }
  });

  socket.on("leave", async ({ roomId }) => {
    try {
      socket.leave(roomKey.all(roomId));
      socket.leave(roomKey.clients(roomId));
      socket.leave(roomKey.pms(roomId));
      socket.leave(roomKey.engineers(roomId));
      // No leave banner emitted
    } catch {}
  });

  socket.on("disconnect", async () => {
    const uid = socketOwners.get(socket.id);
    socketOwners.delete(socket.id);

    if (uid) {
      const set = userSockets.get(uid);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) userSockets.delete(uid);
      }

      const remaining = (presenceCount.get(uid) || 1) - 1;
      if (remaining <= 0) {
        presenceCount.delete(uid);
        await markUserOffline(uid);
        lastSeenActive.delete(uid);
      } else {
        presenceCount.set(uid, remaining);
      }
    }
  });
});

server.listen(config.port, () => {
  console.log(`🚀 Server + Socket.io running on port ${config.port}`);
});

process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
