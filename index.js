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
const io = new SocketIOServer(server, { cors: { origin: config.corsOrigin, credentials: true } });
setIO(io);

// middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://loopp-frontend-v1-zcup.vercel.app/",
    ],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(morgan("dev"));

// static
app.use("/uploads", express.static(path.resolve(__dirname, "uploads")));

// session
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: config.mongoURI, collectionName: "sessions" }),
    cookie: { httpOnly: true, secure: config.env === "production", sameSite: "lax" },
  })
);

// passport
app.use(passport.initialize());
app.use(passport.session());

// db
await connectDB();
initGridFS();

// routes
app.use("/api", routes);

// health
app.get("/", (_req, res) => res.send("✅ API up"));

// errors
app.use((_, __, next) => next(createError(404, "Not Found")));
app.use((err, _req, res, __) => res.status(err.status || 500).json({ success: false, message: err.message }));

// presence: userId -> socket count
const presence = new Map();

io.on("connection", (socket) => {
  // Accept userId via auth OR query for resilience
  const rawId = socket.handshake?.auth?.userId || socket.handshake?.query?.userId || null;
  const userId = rawId ? String(rawId) : null;
  let myUserDoc = null;

  (async () => {
    if (userId) {
      try {
        myUserDoc = await User.findById(userId).lean();
      } catch {}
      socket.join(`user:${userId}`); // personal room for notifications
      const count = (presence.get(userId) || 0) + 1;
      presence.set(userId, count);
      User.updateOne({ _id: userId }, { $set: { online: true, lastActive: new Date() } }).catch(() => {});
    }
  })();

  socket.on("join", async ({ roomId, userId: uid }) => {
    try {
      const room = await ChatRoom.findById(roomId).lean();
      if (!room) return socket.emit("error", "Room not found");
      const isMember = room.members.some((m) => m.toString() === String(uid));
      // if (!isMember || room.isClosed) return socket.emit("error", "Not allowed");

      socket.join(roomId);
      socket.emit("joined", roomId);

      // ensure personal room is joined for this uid as well
      if (uid) socket.join(`user:${String(uid)}`);

      const u = myUserDoc || (await User.findById(uid).lean());
      io.to(roomId).emit("system", {
        type: "join",
        roomId,
        userId: uid,
        name: [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.email || "User",
        role: u?.role || "User",
        timestamp: new Date().toISOString(),
      });
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
        name: [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.email || "User",
        role: u?.role || "User",
        timestamp: new Date().toISOString(),
      });
    } catch {}
  });

  // typing indicator
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

  // optional socket message shortcut
  socket.on("message", async ({ roomId, userId: uid, text = "", attachments = [] }) => {
    try {
      const room = await ChatRoom.findById(roomId).lean();
      if (!room) return socket.emit("error", "Room not found");
      const isMember = room.members.some((m) => m.toString() === String(uid));
      // if (!isMember || room.isClosed) return socket.emit("error", "Not allowed");

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
        senderName: [u?.firstName, u?.lastName].filter(Boolean).join(" ") || "User",
        text,
        attachments,
        createdAt: msg.createdAt,
      });
    } catch (e) {
      socket.emit("error", e.message);
    }
  });

  socket.on("disconnect", async () => {
    if (userId) {
      const remaining = (presence.get(userId) || 1) - 1;
      if (remaining <= 0) {
        presence.delete(userId);
        await User.updateOne({ _id: userId }, { $set: { online: false, lastActive: new Date() } }).catch(() => {});
      } else {
        presence.set(userId, remaining);
      }
    }
  });
});

server.listen(config.port, () => {
  console.log(`🚀 Server + Socket.io running on port ${config.port}`);
});
