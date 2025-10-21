import { ProjectRequest } from "../models/ProjectRequest.js";
import { ChatRoom } from "../models/ChatRoom.js";
import { User } from "../models/User.js";
import { Message } from "../models/Message.js";
import { selectAndClaimPM } from "./pm-selection.service.js";
import { generateClientKey } from "../utils/token.utils.js";
import { logAudit } from "./audit.service.js";
import crypto from "crypto";
import { getIO } from "../lib/io.js";

/* 🔔 notifications */
import { createAndEmit, notifySuperAdmins, links } from "./notify.service.js";

/* ----------------------- helpers: workload & busy state ----------------------- */

async function adjustTaskCount(userId, delta, { touchAssignDate = false } = {}) {
  if (!userId) return null;

  let doc = await User.findByIdAndUpdate(
    userId,
    { $inc: { numberOfTask: delta } },
    { new: true }
  );

  if (!doc) return null;

  if (doc.numberOfTask <= 0) {
    doc.numberOfTask = 0;
    doc.isBusy = false;
  } else {
    doc.isBusy = true;
  }

  if (touchAssignDate && delta > 0) {
    doc.lastDateTaskAssign = new Date();
  }

  await doc.save();
  return doc;
}

/* ------------------------- main service functions ---------------------------- */

export const createProjectRequestAndAssignPM = async (payload, auditMeta = {}) => {
  const {
    firstName,
    lastName,
    email,
    projectTitle,
    projectDescription,
    completionDate,
    clientKey: clientKeyOverride,
    clientId, // ✅ may be null for WP intake
  } = payload;

  const request = await ProjectRequest.create({
    firstName,
    lastName,
    email,
    projectTitle,
    projectDescription,
    completionDate,
    status: "Pending",
    clientKey: clientKeyOverride || generateClientKey(),
    clientId: clientId || null,
  });

  // CLAIM a PM atomically (increments numberOfTask exactly once)
  const pm = await selectAndClaimPM();
  let room = null;

  if (pm) {
    const roomTitle = `${projectTitle} - ${firstName} - ${request._id.toString().slice(-5)}`;

    // ✅ include client in members when we have clientId
    const members = [pm._id];
    if (clientId) members.push(clientId);

    room = await ChatRoom.create({
      title: roomTitle,
      members,
      request: request._id,
      roomKey: crypto.randomBytes(10).toString("base64url"),
      isClosed: false,
      // new fields default false/null but we set explicitly for clarity
      reopenRequestedByClient: false,
      reopenRequestedAt: null,
      reopenRequestedBy: null,
    });

    request.pmAssigned = pm._id;
    request.chatRoom = room._id;
    await request.save();

    // Default greeting from the PM (visible to client when they join)
    try {
      const pmUser = await User.findById(pm._id).lean();
      await Message.create({
        room: room._id,
        senderType: "User",
        sender: pm._id,
        text:
          `Hi ${firstName}, I'm ${[pmUser?.firstName, pmUser?.lastName].filter(Boolean).join(" ") || "your PM"}.\n\n` +
          `I'll be your Project Manager for “${projectTitle}”. Drop what you want us to build and any files you have — ` +
          `let’s turn your idea into reality! 🚀`,
      });
    } catch (_) {}

    // existing personal ping for PM inbox badge
    try {
      getIO()?.to(`user:${pm._id.toString()}`).emit("pm:request_assigned", {
        requestId: request._id.toString(),
        clientName: `${firstName} ${lastName}`.trim(),
        projectTitle,
        roomId: room?._id?.toString() || null,
      });
    } catch (_) {}

    /* 🔔 Notify PM about assignment */
    try {
      await createAndEmit(pm._id, {
        type: "PM_ASSIGNED",
        title: "New project assigned",
        body: `“${projectTitle || "Project"}” from ${firstName} ${lastName}`,
        link: links.chatRoom(room._id),
        meta: { requestId: request._id, roomId: room._id, projectTitle, clientName: `${firstName} ${lastName}` },
      });
    } catch {}
  }

  // 🔔 SuperAdmins: new request came in
  try {
    await notifySuperAdmins({
      type: "PROJECT_REQUEST",
      title: "New project request",
      body: `“${projectTitle || "Untitled"}” by ${firstName} ${lastName}`,
      link: links.adminProject(request._id),
      meta: { requestId: request._id, roomId: room?._id || null, email },
    });
  } catch {}

  await logAudit({
    action: "REQUEST_CREATED",
    actor: null,
    target: request._id,
    targetModel: "ProjectRequest",
    request: request._id,
    room: room?._id || null,
    meta: { pmAssigned: pm?._id || null, ...auditMeta },
  });

  return { request, pm, room };
};

export const setEngineerForRequest = async (requestId, engineerId, pmUser, auditMeta = {}) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req) throw new Error("Request not found");
  if (!req.pmAssigned?.equals(pmUser._id)) throw new Error("Only assigned PM can set engineer");

  req.engineerAssigned = engineerId;
  await req.save();

  await logAudit({
    action: "ENGINEER_ASSIGNED",
    actor: pmUser._id,
    target: req._id,
    targetModel: "ProjectRequest",
    request: req._id,
    room: req.chatRoom,
    meta: { engineerId, ...auditMeta },
  });

  /* 🔔 Notify Engineer */
  try {
    await createAndEmit(engineerId, {
      type: "ENGINEER_ASSIGNED",
      title: "You’ve been assigned a project",
      body: `“${req.projectTitle || "Project"}” by ${req.firstName} ${req.lastName}`,
      link: links.engineerTask(req._id),
      meta: { requestId: req._id },
    });
  } catch {}

  return req;
};

export const engineerAcceptsTask = async (requestId, engineerUser, auditMeta = {}) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req) throw new Error("Request not found");
  if (!req.engineerAssigned?.equals(engineerUser._id)) throw new Error("Not your request");

  // idempotent flag so reopen knows we had an accepted engineer before
  if (req.__engineerAccepted) return req;
  req.__engineerAccepted = true;
  await req.save();

  // ❌ Do NOT adjust workload here (to avoid double counting).
  // Workload increments when the engineer accepts the TASK (task.service#engineerAcceptTask).

  await logAudit({
    action: "ENGINEER_ACCEPTED",
    actor: engineerUser._id,
    target: req._id,
    targetModel: "ProjectRequest",
    request: req._id,
    room: req.chatRoom,
    meta: auditMeta,
  });

  /* 🔔 Notify PM + SuperAdmins */
  try {
    if (req.pmAssigned) {
      await createAndEmit(req.pmAssigned, {
        type: "ENGINEER_ACCEPTED",
        title: "Engineer accepted the task",
        body: `Engineer accepted “${req.projectTitle || "Project"}”`,
        link: links.chatRoom(req.chatRoom),
        meta: { requestId: req._id, roomId: req.chatRoom },
      });
    }
    await notifySuperAdmins({
      type: "ENGINEER_ACCEPTED",
      title: "Engineer accepted",
      body: `Engineer accepted “${req.projectTitle || "Project"}”`,
      link: links.adminProject(req._id),
      meta: { requestId: req._id },
    });
  } catch {}

  return req;
};

export const markRequestReview = async (requestId, engineerUser, auditMeta = {}) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req) throw new Error("Request not found");
  if (!req.engineerAssigned?.equals(engineerUser._id)) throw new Error("Not your request");

  req.status = "Review";
  await req.save();

  try {
    getIO()?.to(req.chatRoom.toString()).emit("project:review", {
      requestId: req._id.toString(),
      status: "Review",
    });
  } catch (_) {}

  await logAudit({
    action: "REQUEST_TO_REVIEW",
    actor: engineerUser._id,
    target: req._id,
    targetModel: "ProjectRequest",
    request: req._id,
    room: req.chatRoom,
    meta: auditMeta,
  });

  /* 🔔 Notify PM + SuperAdmins */
  try {
    if (req.pmAssigned) {
      await createAndEmit(req.pmAssigned, {
        type: "STATUS_REVIEW",
        title: "Project moved to Review",
        body: `“${req.projectTitle || "Project"}” is ready for review`,
        link: links.chatRoom(req.chatRoom),
        meta: { requestId: req._id, roomId: req.chatRoom },
      });
    }
    await notifySuperAdmins({
      type: "STATUS_REVIEW",
      title: "Project in Review",
      body: `“${req.projectTitle || "Project"}” moved to Review`,
      link: links.adminProject(req._id),
      meta: { requestId: req._id },
    });
  } catch {}

  return req;
};

export const rateAndComplete = async (requestId, ratingPayload, auditMeta = {}) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req) throw new Error("Request not found");
  if (req.status !== "Review") throw new Error("Not in review");

  req.ratings = {
    pm: { score: ratingPayload.pmScore, comment: ratingPayload.pmComment },
    engineer: { score: ratingPayload.engineerScore, comment: ratingPayload.engineerComment },
    coordination: { score: ratingPayload.coordinationScore, comment: ratingPayload.coordinationComment },
  };
  await req.save();

  try {
    getIO()?.to(req.chatRoom.toString()).emit("rated", {
      requestId: req._id.toString(),
      ratings: req.ratings,
    });
  } catch (_) {}

  await logAudit({
    action: "REQUEST_RATED",
    actor: null,
    target: req._id,
    targetModel: "ProjectRequest",
    request: req._id,
    room: req.chatRoom,
    meta: ratingPayload ? { ...ratingPayload, ...auditMeta } : auditMeta,
  });

  /* 🔔 Notify PM & Engineer & SuperAdmins */
  try {
    if (req.pmAssigned) {
      await createAndEmit(req.pmAssigned, {
        type: "CLIENT_RATED",
        title: "Client submitted a rating",
        body: `Rating received for “${req.projectTitle || "Project"}”`,
        link: links.chatRoom(req.chatRoom),
        meta: { requestId: req._id, roomId: req.chatRoom },
      });
    }
    if (req.engineerAssigned) {
      await createAndEmit(req.engineerAssigned, {
        type: "CLIENT_RATED",
        title: "Client submitted a rating",
        body: `Rating received for “${req.projectTitle || "Project"}”`,
        link: links.chatRoom(req.chatRoom),
        meta: { requestId: req._id, roomId: req.chatRoom },
      });
    }
    await notifySuperAdmins({
      type: "CLIENT_RATED",
      title: "Client rated",
      body: `Client rated “${req.projectTitle || "Project"}”`,
      link: links.adminProject(req._id),
      meta: { requestId: req._id },
    });
  } catch {}

  return req;
};

export const closeRoomAndComplete = async (requestId, pmUser, auditMeta = {}) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req) throw new Error("Request not found");
  if (!req.pmAssigned?.equals(pmUser._id)) throw new Error("Only assigned PM can close");

  if (!req.ratings || !req.ratings.pm || !req.ratings.engineer) {
    throw new Error("Please ensure client ratings are submitted before closing.");
  }

  if (req.chatRoom) {
    await (await ChatRoom.findById(req.chatRoom)).updateOne({
      $set: {
        isClosed: true,
        reopenRequestedByClient: false,
        reopenRequestedAt: null,
        reopenRequestedBy: null,
      },
    });
  }

  if (req.pmAssigned) await adjustTaskCount(req.pmAssigned, -1);
  if (req.engineerAssigned) await adjustTaskCount(req.engineerAssigned, -1);

  req.status = "Complete";
  await req.save();

  try {
    getIO()?.to(req.chatRoom.toString()).emit("room:closed", {
      roomId: req.chatRoom.toString(),
      at: new Date().toISOString(),
    });
  } catch (_) {}

  await logAudit({
    action: "REQUEST_COMPLETED",
    actor: pmUser._id,
    target: req._id,
    targetModel: "ProjectRequest",
    request: req._id,
    room: req.chatRoom,
    meta: auditMeta,
  });

  try {
    await notifySuperAdmins({
      type: "PROJECT_CLOSED",
      title: "Project completed",
      body: `“${req.projectTitle || "Project"}” marked Complete`,
      link: links.adminProject(req._id),
      meta: { requestId: req._id },
    });
  } catch {}

  return req;
};

/** ✅ NEW: client requests reopen (sets flags, notifies PM, emits socket) */
export const clientRequestsReopen = async (roomId, authUser, auditMeta = {}) => {
  const room = await ChatRoom.findById(roomId);
  if (!room) throw new Error("Room not found");

  const pr = await ProjectRequest.findOne({ chatRoom: room._id });
  if (!pr) throw new Error("Project not found for this room");

  // ---- membership/ownership check (allow closed rooms) ----
  const isMember =
    room.members?.some?.((m) => m.toString() === authUser._id.toString()) ||
    (pr.clientId && pr.clientId.toString() === authUser._id.toString());

  if (!isMember) throw new Error("Forbidden: not a member of this room");

  // Room must be closed to request reopen
  if (!room.isClosed) throw new Error("Room is not closed");

  // If already requested, be idempotent
  if (!room.reopenRequestedByClient) {
    room.reopenRequestedByClient = true;
    await room.save();

    // audit
    await logAudit({
      action: "CLIENT_REQUEST_REOPEN",
      actor: authUser._id || null,
      target: pr._id,
      targetModel: "ProjectRequest",
      request: pr._id,
      room: room._id,
      meta: auditMeta,
    });

    // notify PM (if assigned)
    try {
      if (pr.pmAssigned) {
        const pm = await User.findById(pr.pmAssigned).lean();
        await createAndEmit(pr.pmAssigned, {
          type: "CLIENT_REOPEN_REQUEST",
          title: "Client requested to reopen a room",
          body: `“${room.title || "Room"}” — ${pr.firstName || ""} ${pr.lastName || ""}`.trim(),
          link: links.chatRoom(room._id),
          meta: {
            requestId: pr._id,
            roomId: room._id,
            projectTitle: pr.projectTitle || "",
            clientName: `${pr.firstName || ""} ${pr.lastName || ""}`.trim(),
          },
        });

        // optional realtime ping to PM channel
        getIO()?.to(`user:${String(pm?._id || pr.pmAssigned)}`).emit("room:reopen_requested", {
          roomId: room._id.toString(),
          requestId: pr._id.toString(),
          projectTitle: pr.projectTitle || "",
          clientName: `${pr.firstName || ""} ${pr.lastName || ""}`.trim(),
        });
      }
    } catch {}
  }

  return { room, project: pr };
};

// When PM actually reopens, clear the flag
export const reopenRoomAndResume = async (requestId, pmUser, auditMeta = {}) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req) throw new Error("Request not found");
  if (!req.pmAssigned?.equals(pmUser._id)) throw new Error("Only assigned PM can reopen");

  const room = req.chatRoom ? await ChatRoom.findById(req.chatRoom) : null;
  if (!room) throw new Error("Room not found");
  if (!room.isClosed) return req; // idempotent: only act when actually closed

  // reopen the room
  await room.updateOne({ $set: { isClosed: false, reopenRequestedByClient: false } });

  // ✅ Always bump workload on reopen
  if (req.pmAssigned) {
    await adjustTaskCount(req.pmAssigned, +1, { touchAssignDate: true });
  }
  if (req.engineerAssigned) {
    await adjustTaskCount(req.engineerAssigned, +1, { touchAssignDate: true });
  }

  req.status = "InProgress";
  await req.save();

  try {
    getIO()?.to(req.chatRoom.toString()).emit("room:reopened", {
      roomId: req.chatRoom.toString(),
      at: new Date().toISOString(),
    });
  } catch (_) {}

  await logAudit({
    action: "REQUEST_REOPENED",
    actor: pmUser._id,
    target: req._id,
    targetModel: "ProjectRequest",
    request: req._id,
    room: req.chatRoom,
    meta: auditMeta,
  });

  try {
    await notifySuperAdmins({
      type: "PROJECT_REOPENED",
      title: "Project reopened",
      body: `“${req.projectTitle || "Project"}” was reopened`,
      link: links.adminProject(req._id),
      meta: { requestId: req._id },
    });
  } catch {}

  return req;
}
