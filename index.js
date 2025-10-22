// backend/index.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import session from "express-session";
import MongoStore from "connect-mongo";
import passport from "passport";
import createError from "http-errors";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { setIO } from "./src/lib/io.js";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// ===== CORS allowlist (no trailing slashes!) =====
const ALLOWLIST = [
  "http://localhost:5173",
  "https://loopp-frontend-v1.vercel.app",
  "https://loopp-frontend-v1-zcup.vercel.app",
];

// Trust Render/Heroku-style proxy so secure cookies work
app.set("trust proxy", 1);

const corsOptions = {
  origin(origin, cb) {
    // Allow same-origin tools (curl/Postman) that send no Origin
    if (!origin) return cb(null, true);
    return cb(null, ALLOWLIST.includes(origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

// Apply CORS to all routes (handles simple requests)
app.use(cors(corsOptions));
// ✅ Express 5: use a regex for OPTIONS instead of "*"
app.options(/.*/, cors(corsOptions));

// ===== Body/utility middleware =====
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(morgan("dev"));

// ===== Static files =====
app.use("/uploads", express.static(path.resolve(__dirname, "uploads")));

// ===== Session (SameSite=None; Secure for cross-site cookies) =====
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: config.mongoURI,
      collectionName: "sessions",
    }),
    cookie: {
      httpOnly: true,
      secure: config.env === "production", // true on Render
      sameSite: "none", // required for cross-site cookies
    },
  })
);

// ===== Passport =====
app.use(passport.initialize());
app.use(passport.session());

// ===== DB & GridFS =====
await connectDB();
initGridFS();

// ===== API routes =====
app.use("/api", routes);

// ===== Healthcheck =====
app.get("/", (_req, res) => res.send("✅ API up"));

// ===== Errors =====
app.use((_, __, next) => next(createError(404, "Not Found")));
app.use((err, _req, res, __) =>
  res.status(err.status || 500).json({ success: false, message: err.message })
);

// ===== Socket.IO (CORS mirrors HTTP allowlist) =====
const io = new SocketIOServer(server, {
  cors: { origin: ALLOWLIST, credentials: true },
});
setIO(io);

// Presence: userId -> socket count
const presence = new Map();

// Guards to reduce duplicate inline notices
const pmAnnounced = new Set(); // Set<roomId>
const engineerFirstJoin = new Set(); // Set<`${roomId}:${userId}`>

io.on("connection", (socket) => {
  const rawId =
    socket.handshake?.auth?.userId || socket.handshake?.query?.userId || null;
  const userId = rawId ? String(rawId) : null;
  let myUserDoc = null;

  (async () => {
    if (userId) {
      try {
        myUserDoc = await User.findById(userId).lean();
      } catch {}
      socket.join(`user:${userId}`);
      const count = (presence.get(userId) || 0) + 1;
      presence.set(userId, count);
      User.updateOne(
        { _id: userId },
        { $set: { online: true, lastActive: new Date() } }
      ).catch(() => {});
    }
  })();

  socket.on("join", async ({ roomId, userId: uid }) => {
    try {
      const room = await ChatRoom.findById(roomId).lean();
      if (!room) return socket.emit("error", "Room not found");

      socket.join(roomId);
      socket.emit("joined", roomId);
      if (uid) socket.join(`user:${String(uid)}`);

      const u = myUserDoc || (await User.findById(uid).lean());
      const role = (u?.role || "User").toString();

      // Generic system "join" (kept as-is)
      io.to(roomId).emit("system", {
        type: "join",
        roomId,
        userId: uid,
        name:
          [u?.firstName, u?.lastName].filter(Boolean).join(" ") ||
          u?.email ||
          "User",
        role,
        timestamp: new Date().toISOString(),
      });

      // -----------------------------------------------
      // 🚨 NEW: Announce PM assignment BEFORE any greeting,
      // independent of PM online status.
      // We consider any of these fields as "PM assigned":
      //   room.pm, room.assignedPM, room.pmId
      // -----------------------------------------------
      const pmId =
        room?.pm?.toString?.() ||
        room?.assignedPM?.toString?.() ||
        room?.pmId?.toString?.() ||
        null;

      const pmIsAssigned = Boolean(pmId);

      if (pmIsAssigned && !pmAnnounced.has(String(roomId))) {
        // (1) Emit inline notice FIRST
        pmAnnounced.add(String(roomId));
        io.to(roomId).emit("system", {
          type: "pm_assigned",
          roomId,
          role: "PM",
          timestamp: new Date().toISOString(),
        });

        // (2) Create/sync the default PM greeting only once (idempotent)
        const alreadyWelcomed = await Message.exists({
          room: roomId,
          kind: "pm_welcome",
        });

        if (!alreadyWelcomed) {
          // Load PM doc for name, fallback to generic "PM"
          let pmDoc = null;
          try {
            pmDoc = await User.findById(pmId).lean();
          } catch {}

          const pmName =
            [pmDoc?.firstName, pmDoc?.lastName].filter(Boolean).join(" ") ||
            "PM";

          const text =
            `Hi! I’m ${pmName}. I’ll coordinate this project and keep you updated here. ` +
            `Please share requirements, files, or questions anytime — we’ll get rolling.`;

          const msg = await Message.create({
            room: roomId,
            senderType: "User", // keep schema consistent with your current use
            sender: pmId, // tie greeting to the assigned PM
            text,
            attachments: [],
            kind: "pm_welcome", // <-- makes this idempotent
          });

          // Emit AFTER the inline notice to guarantee ordering
          io.to(roomId).emit("message", {
            _id: msg._id,
            room: roomId,
            sender: pmId,
            senderType: "User",
            senderRole: "PM",
            senderName: pmName,
            text,
            attachments: [],
            createdAt: msg.createdAt,
          });
        }
      }
      // -----------------------------------------------

      // Role-specific presence/online inline notices
      if (/pm|project\s*manager/i.test(role)) {
        // Show "PM is actively online" when actual PM joins (optional keep)
        io.to(roomId).emit("system", {
          type: "pm_online",
          roomId,
          role: "PM",
          timestamp: new Date().toISOString(),
        });
      }

      if (/engineer/i.test(role)) {
        // a) First time this engineer joins the room -> "ENGINEER IS IN THE ROOM"
        const tag = `${roomId}:${String(uid)}`;
        if (!engineerFirstJoin.has(tag)) {
          engineerFirstJoin.add(tag);
          io.to(roomId).emit("system", {
            type: "engineer_joined",
            roomId,
            role: "Engineer",
            timestamp: new Date().toISOString(),
          });
        }
        // b) Presence heartbeat -> "ENGINEER IS IN THE ROOM"
        io.to(roomId).emit("system", {
          type: "engineer_online",
          roomId,
          role: "Engineer",
          timestamp: new Date().toISOString(),
        });
      }
    } catch (e) {
      socket.emit("error", e.message);
    }
  });

  socket.on("leave", async ({ roomId }) => {
    try {
      socket.leave(roomId);
      const u = myUserDoc || (await User.findById(userId).lean());
      io.to(roomId).emit("system", {
        type: "leave",
        roomId,
        userId,
        name:
          [u?.firstName, u?.lastName].filter(Boolean).join(" ") ||
          u?.email ||
          "User",
        role: u?.role || "User",
        timestamp: new Date().toISOString(),
      });
    } catch {}
  });

  socket.on("typing", async ({ roomId, userId: uid, role, isTyping }) => {
    try {
      const room = await ChatRoom.findById(roomId);
      if (!room) return;
      if (isTyping) room.typing.set(String(uid), role || "User");
      else room.typing.delete(String(uid));
      await room.save();
      socket.to(roomId).emit("typing", { roomId, userId: uid, role, isTyping });
    } catch (_) {}
  });

  socket.on(
    "message",
    async ({ roomId, userId: uid, text = "", attachments = [] }) => {
      try {
        const room = await ChatRoom.findById(roomId).lean();
        if (!room) return socket.emit("error", "Room not found");

        const u = myUserDoc || (await User.findById(uid).lean());
        const msg = await Message.create({
          room: roomId,
          senderType: "User",
          sender: uid,
          text,
          attachments,
        });

        io.to(roomId).emit("message", {
          _id: msg._id,
          room: roomId,
          sender: uid,
          senderType: "User",
          senderRole: u?.role || "User",
          senderName:
            [u?.firstName, u?.lastName].filter(Boolean).join(" ") || "User",
          text,
          attachments,
          createdAt: msg.createdAt,
        });
      } catch (e) {
        socket.emit("error", e.message);
      }
    }
  );

  socket.on("disconnect", async () => {
    if (userId) {
      const remaining = (presence.get(userId) || 1) - 1;
      if (remaining <= 0) {
        presence.delete(userId);
        await User.updateOne(
          { _id: userId },
          { $set: { online: false, lastActive: new Date() } }
        ).catch(() => {});
      } else {
        presence.set(userId, remaining);
      }
    }
  });
});

server.listen(config.port, () => {
  console.log(`🚀 Server + Socket.io running on port ${config.port}`);
});
