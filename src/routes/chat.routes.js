import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { upload } from "../lib/upload.js";
import {
  sendMessage,
  getMessages,
  clientSendMessage,
  clientGetMessages,
  myRooms,
  getRoomByKey,
  myClientRooms,
  getClientRoomMessages,
  clientRoomSend,
} from "../controllers/chat.controller.js";

const router = express.Router();

/* ---------- Staff/member endpoints ---------- */
router.post("/send", requireAuth, upload.array("files", 6), sendMessage);
router.get("/:roomId/messages", requireAuth, getMessages);
router.get("/my-rooms", requireAuth, myRooms);
router.get("/room/key/:key", requireAuth, getRoomByKey);

/* ---------- Public client-key endpoints (key in query/body) ---------- */
router.post("/client/send", upload.array("files", 6), clientSendMessage);
router.get("/client/:requestId/messages", clientGetMessages);

/* ---------- Client-auth (by clientId) endpoints ---------- */
router.get("/my-client-rooms", requireAuth, myClientRooms);
router.get("/client-room/:roomId/messages", requireAuth, getClientRoomMessages);
router.post("/client-room/send", requireAuth, upload.array("files", 6), clientRoomSend);

export default router
