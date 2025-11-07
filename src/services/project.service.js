// src/services/project.service.js
import { ProjectRequest } from "../models/ProjectRequest.js";
import { ChatRoom } from "../models/ChatRoom.js";
import { User } from "../models/User.js";
import { Message } from "../models/Message.js";
import {
  selectAndClaimOnlinePM,
  tryClaimSpecificPM,
  ONLINE_WINDOW_MS,
} from "./pm-selection.service.js";
import { generateClientKey } from "../utils/token.utils.js";
import { logAudit } from "./audit.service.js";
import crypto from "crypto";
import { getIO } from "../lib/io.js";

/* 🔔 notifications (socket + in-app) */
import { createAndEmit, notifySuperAdmins, links } from "./notify.service.js";

/* NEW: scoped emit + persist for client-only system bubbles */
import { roomKey, saveAndEmitSystemForClients } from "../lib/io.js";

/* ✉️ Email hooks (Brevo/Nodemailer-backed, rich HTML templates) */
import {
  emailClientNewRequest,
  emailSuperAdminsNewRequest,
  emailPMsBroadcastNewRequest,
  emailClientThankYou,

  // NEW: rich templates used to fix the “single-line” mails
  emailClientEngineerAssigned,
  emailClientEngineerAccepted,
  emailPMsEngineerAccepted,
  emailSuperAdminsEngineerAccepted,
  emailPMsOnPmAssigned,
  emailSuperAdminsAssigned,
} from "./email.service.js";

/* -------------------------------- FOLLOW-UP SCHEDULER -------------------------------- */

async function startStandbyFollowups(roomId, requestId) {
  const io = getIO();
  if (!io) return;

  // internal helper to safely send message
  const send = async (text, kind) => {
    try {
      await saveAndEmitSystemForClients({ roomId, text, kind });
    } catch {}
  };

  // ⏱️ EXACT INTERVALS REQUESTED: 30s, 40s, then every 60s
  const intervals = [30_000, 40_000]; // 30s first, 40s next
  let tick = 0;

  const loop = async () => {
    const req = await ProjectRequest.findById(requestId).select("pmAssigned").lean();
    if (!req || req.pmAssigned) return; // stop once assigned

    // check active presence: at least one socket joined this room's clients
    const roomClients = io.sockets.adapter.rooms.get(`room:${roomId}:clients`);
    const isActive = roomClients && roomClients.size > 0;
    if (!isActive) {
      // if client left, pause — retry later when they rejoin
      setTimeout(loop, 15_000);
      return;
    }

    tick++;
    if (tick === 1) {
      await send(
        "We’re still connecting you to an available Project Manager. Thanks for holding on!",
        "followup_30s"
      );
      setTimeout(loop, intervals[1]); // 40s next
    } else if (tick === 2) {
      await send(
        "Almost there — our team is finishing with other clients and will join shortly.",
        "followup_40s"
      );
      setTimeout(loop, 60_000); // after this, every 60 s
    } else {
      await send(
        "Thanks for your patience. We’re still finding the best Project Manager to assist you.",
        "followup_repeat"
      );
      setTimeout(loop, 60_000);
    }
  };

  // first follow-up at 30 s
  setTimeout(loop, intervals[0]);
}

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

/** CAS: claim this request for pmId only if pmAssigned is still empty. */
async function safeSetPmAssigned(requestId, pmId) {
  const res = await ProjectRequest.updateOne(
    { _id: requestId, $or: [{ pmAssigned: null }, { pmAssigned: { $exists: false } }] },
    { $set: { pmAssigned: pmId, status: "Pending" } }
  );
  return res.modifiedCount > 0;
}

/** Rollback PM claim if failed to set pmAssigned (prevents double-assign). */
async function rollbackPmClaim(pmId) {
  if (!pmId) return;
  await adjustTaskCount(pmId, -1);
}

async function finalizePmAssignment({ request, room, pm }) {
  // ensure membership includes PM
  await ChatRoom.updateOne({ _id: room._id }, { $addToSet: { members: pm._id } });
  // also persist PM onto the room so sockets/UI can detect "already assigned"
  await ChatRoom.updateOne({ _id: room._id }, { $set: { pm: pm._id } });

  // small helper to yield a micro-tick to the event loop
  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

  try {
    const pmUser = await User.findById(pm._id).lean();
    const pmName = [pmUser?.firstName, pmUser?.lastName].filter(Boolean).join(" ") || "PM";

    // 1) Persist + emit the CLIENT-ONLY system bubble first
    await saveAndEmitSystemForClients({
      roomId: room._id.toString(),
      kind: "pm_assigned",
      text: `${pmName} has been assigned as your PM. They’ll join shortly.`,
    });

    // Give the socket a brief head start to render the system bubble first
    await tick(50);

    // 2) Immediately inform the room (used by clients to show the inline banner)
    getIO()?.to(room._id.toString()).emit("room:pm_assigned", {
      roomId: room._id.toString(),
      requestId: String(request._id),
      pm: {
        id: String(pm._id),
        firstName: pmUser?.firstName || "",
        lastName: pmUser?.lastName || "",
        email: pmUser?.email || "",
      },
      at: new Date().toISOString(),
    });

    // 3) Upsert the PM welcome (idempotent); emit only if newly inserted
    const welcomeText =
      `Hi! I’m ${pmName}. I’ll coordinate this project and keep you updated here. ` +
      `Please share requirements, files, or questions anytime — we’ll get rolling.`;

    // Ensure welcome message sorts AFTER the assigned system bubble
    const welcomeCreatedAt = new Date(Date.now() + 250);

    const upsert = await Message.findOneAndUpdate(
      { room: room._id, kind: "pm_welcome" },
      {
        $setOnInsert: {
          room: room._id,
          senderType: "User",
          sender: pm._id,
          text: welcomeText,
          attachments: [],
          kind: "pm_welcome",
          createdAt: welcomeCreatedAt,
          updatedAt: welcomeCreatedAt,
        },
      },
      { upsert: true, new: true, rawResult: true }
    );

    const wasInserted = !!upsert?.lastErrorObject?.upserted;
    const msgDoc = upsert?.value;

    if (wasInserted && msgDoc) {
      getIO()
        ?.to(roomKey.all(room._id.toString()))
        .emit("message", {
          _id: msgDoc._id,
          room: room._id.toString(),
          sender: pm._id.toString(),
          senderType: "User",
          senderRole: "PM",
          senderName: pmName,
          text: welcomeText,
          attachments: [],
          createdAt: msgDoc.createdAt,
        });
    }
  } catch {
    // swallow — non-critical for ordering guarantees
  }

  // (C) notify PM (badge + in-app)
  try {
    getIO()?.to(`user:${pm._id.toString()}`).emit("pm:request_assigned", {
      requestId: request._id.toString(),
      clientName: `${request.firstName} ${request.lastName}`.trim(),
      projectTitle: request.projectTitle,
      roomId: room?._id?.toString() || null,
    });

    await logAudit({
      action: "PM_ASSIGNED",
      actor: null,
      target: request._id,
      targetModel: "ProjectRequest",
      request: request._id,
      room: room._id,
      meta: { pmAssigned: pm._id },
    });

    await createAndEmit(pm._id, {
      type: "PM_ASSIGNED",
      title: "New project assigned",
      body: `“${request.projectTitle || "Project"}” from ${request.firstName} ${request.lastName}`,
      link: links.chatRoom(room._id),
      meta: {
        requestId: request._id,
        roomId: room._id,
        projectTitle: request.projectTitle,
        clientName: `${request.firstName} ${request.lastName}`,
      },
    });
  } catch {}

  // (D) ✉️ EMAILS (fire-and-forget): tell staff PM is assigned (rich HTML)
  (async () => {
    try {
      const [sas, pmEmails, pmUser] = await Promise.all([
        getSuperAdmins(),
        getPMEmails(),
        User.findById(pm._id).lean(),
      ]);
      const pmName = [pmUser?.firstName, pmUser?.lastName].filter(Boolean).join(" ") || "PM";
      await Promise.allSettled([
        emailPMsOnPmAssigned(request, pmName, pmEmails || []),
        emailSuperAdminsAssigned(request, pmName, sas || [], /* engineerName */ undefined),
      ]);
    } catch (e) {
      console.warn("[mail] PM-assigned email flow failed:", e?.message);
    }
  })();
}

/* ------------------------- utility lookups for email ------------------------- */

async function getSuperAdmins() {
  return User.find({ role: { $in: ["SuperAdmin", "SUPERADMIN", "ADMIN"] }, email: { $exists: true } })
    .select("_id email firstName lastName")
    .lean();
}

async function getPMEmails() {
  const pms = await User.find({ role: /pm/i, email: { $exists: true } })
    .select("email")
    .lean();
  return pms.map((p) => p.email).filter(Boolean);
}

/* ------------------------- main: create request + assign ---------------------------- */

export const createProjectRequestAndAssignPM = async (payload, auditMeta = {}) => {
  const {
    firstName,
    lastName,
    email,
    projectTitle,
    projectDescription,
    completionDate,
    clientKey: clientKeyOverride,
    clientId, // may be null (e.g., WP intake)
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

  const roomTitle = `${projectTitle} - ${firstName} - ${request._id.toString().slice(-5)}`;

  // include client in members when we have clientId
  const members = [];
  if (clientId) members.push(clientId);

  const room = await ChatRoom.create({
    title: roomTitle,
    members,
    request: request._id,
    roomKey: crypto.randomBytes(10).toString("base64url"),
    isClosed: false,
    reopenRequestedByClient: false,
  });

  request.chatRoom = room._id;
  await request.save();

  // ✉️ Send emails (fire-and-forget; don’t block UX)
  (async () => {
    try {
      const [sas, pmEmails] = await Promise.all([getSuperAdmins(), getPMEmails()]);
      const results = await Promise.allSettled([
        emailClientNewRequest(request),
        emailSuperAdminsNewRequest(request, sas || []),
        emailPMsBroadcastNewRequest(request, pmEmails || []),
      ]);
      console.log(
        "[mail] New project notification results:",
        results.map((r) => (r.status === "fulfilled" ? r.value : r.reason))
      );
    } catch (e) {
      console.error("[mail] createProjectRequestAndAssignPM error:", e);
    }
  })();

  // Try strict ONLINE assignment now (no offline fallback)
  let pm = await selectAndClaimOnlinePM();

  if (pm) {
    const ok = await safeSetPmAssigned(request._id, pm._id);
    if (ok) {
      const reqDoc = await ProjectRequest.findById(request._id);
      await finalizePmAssignment({ request: reqDoc, room, pm });
    } else {
      await rollbackPmClaim(pm._id);
      pm = null;
    }
  }

  // If no PM online → standby bubble (client-only) + follow-ups
  if (!pm) {
    try {
      await saveAndEmitSystemForClients({
        roomId: room._id.toString(),
        text:
          "All our PMs are currently assisting other clients. You're in the right place — a PM will join this chat shortly. Thanks for your patience!",
        kind: "standby",
      });

      // 🔁 Schedule polite follow-ups at 30s, 40s, then every 60s
      startStandbyFollowups(room._id.toString(), request._id.toString());
    } catch {}
  }

  // SuperAdmins: keep receiving the original “new request” signal
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

/* -------------------- standby auto-assign on PM presence -------------------- */

export const autoAssignFromStandby = async () => {
  const pending = await ProjectRequest.findOne({
    status: "Pending",
    chatRoom: { $ne: null },
    $or: [{ pmAssigned: null }, { pmAssigned: { $exists: false } }],
  })
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  if (!pending) return { assigned: false };

  const pm = await selectAndClaimOnlinePM();
  if (!pm) return { assigned: false };

  const ok = await safeSetPmAssigned(pending._id, pm._id);
  if (!ok) {
    await rollbackPmClaim(pm._id);
    return { assigned: false };
  }

  const room = await ChatRoom.findById(pending.chatRoom).lean();
  const reqDoc = await ProjectRequest.findById(pending._id);
  await finalizePmAssignment({ request: reqDoc, room, pm });
  return { assigned: true, requestId: String(reqDoc._id), pmId: String(pm._id) };
};

export const autoAssignFromStandbyForPM = async (pmId) => {
  const pending = await ProjectRequest.findOne({
    status: "Pending",
    chatRoom: { $ne: null },
    $or: [{ pmAssigned: null }, { pmAssigned: { $exists: false } }],
  })
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  if (!pending) return { assigned: false };

  // Try this specific PM first — only if free/online
  let pm = await tryClaimSpecificPM(pmId, { preferFree: true, allowBusyFallback: false });

  if (!pm) {
    // If someone free exists, let general picker handle it; else pick least-loaded online
    const someoneFree = await User.exists({
      role: "PM",
      isBusy: false,
      online: true,
      lastActive: { $gte: new Date(Date.now() - ONLINE_WINDOW_MS) },
    });

    if (someoneFree) return autoAssignFromStandby();

    pm = await selectAndClaimOnlinePM();
    if (!pm) return { assigned: false };
  }

  const ok = await safeSetPmAssigned(pending._id, pm._id);
  if (!ok) {
    await rollbackPmClaim(pm._id);
    return { assigned: false };
  }

  const room = await ChatRoom.findById(pending.chatRoom).lean();
  const reqDoc = await ProjectRequest.findById(pending._id);
  await finalizePmAssignment({ request: reqDoc, room, pm });
  return { assigned: true, requestId: String(reqDoc._id), pmId: String(pm._id) };
};

/* ========================================================================== */
/*                            Remaining flows (UPDATED)                        */
/* ========================================================================== */

export const setEngineerForRequest = async (requestId, engineerId, pmUser, auditMeta = {}) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req) throw new Error("Request not found");
  if (!req.pmAssigned?.equals(pmUser._id)) throw new Error("Only assigned PM can set engineer");

  req.engineerAssigned = engineerId;
  await req.save();

  // 📧 Email the client with a rich, designed template
  try {
    const [pmDoc, engDoc] = await Promise.all([
      User.findById(req.pmAssigned).lean(),
      User.findById(engineerId).lean(),
    ]);
    const pmName  = [pmDoc?.firstName, pmDoc?.lastName].filter(Boolean).join(" ");
    const engName = [engDoc?.firstName, engDoc?.lastName].filter(Boolean).join(" ");
    // Designed HTML:
    await emailClientEngineerAssigned(req, engName, pmName);
  } catch (e) {
    console.error("[mail] emailClientEngineerAssigned failed:", e?.message);
  }

  // 🔴 Permanent system bubble (client-only): PM assigned an engineer
  let engDoc = null;
  let engName = "";
  try {
    engDoc = await User.findById(engineerId).lean();
    engName = [engDoc?.firstName, engDoc?.lastName].filter(Boolean).join(" ");
    await saveAndEmitSystemForClients({
      roomId: req.chatRoom.toString(),
      text: `PM has assigned the project to an Engineer${engName ? ` — (${engName})` : ""}.`,
      kind: "pm_assigned_engineer",
    });
  } catch {}

  await logAudit({
    action: "ENGINEER_ASSIGNED",
    actor: pmUser._id,
    target: req._id,
    targetModel: "ProjectRequest",
    request: req._id,
    room: req.chatRoom,
    meta: { engineerId, ...auditMeta },
  });

  // Notify the engineer in-app
  try {
    await createAndEmit(engineerId, {
      type: "ENGINEER_ASSIGNED",
      title: "You’ve been assigned a project",
      body: `“${req.projectTitle || "Project"}” by ${req.firstName} ${req.lastName}`,
      link: links.engineerTask(req._id),
      meta: { requestId: req._id },
    });
  } catch {}

  // ✉️ EMAIL (fire-and-forget): Client gets rich “Engineer assigned” email
  (async () => {
    try {
      const pmDoc = await User.findById(pmUser._id).lean();
      const pmName = [pmDoc?.firstName, pmDoc?.lastName].filter(Boolean).join(" ");
      await emailClientEngineerAssigned(req, engName || (engDoc?.email ? engDoc.email : "Engineer"), pmName || "PM");
    } catch (e) {
      console.warn("[mail] client EngineerAssigned email failed:", e?.message);
    }
  })();

  return req;
};

export const engineerAcceptsTask = async (requestId, engineerUser, auditMeta = {}) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req) throw new Error("Request not found");
  if (!req.engineerAssigned?.equals(engineerUser._id)) throw new Error("Not your request");

  if (req.__engineerAccepted) return req;
  req.__engineerAccepted = true;
  await req.save();

  // 📧 Emails: client + PMs + SuperAdmins (rich templates)
  (async () => {
    try {
      const [pmDoc, engDoc, superAdmins, pmEmails] = await Promise.all([
        req.pmAssigned ? User.findById(req.pmAssigned).lean() : null,
        User.findById(engineerUser._id).lean(),
        getSuperAdmins(),       // you already have this helper above
        getPMEmails(),          // you already have this helper above
      ]);
      const pmName  = [pmDoc?.firstName, pmDoc?.lastName].filter(Boolean).join(" ") || "";
      const engName = [engDoc?.firstName, engDoc?.lastName].filter(Boolean).join(" ") || "";

      await Promise.allSettled([
        emailClientEngineerAccepted(req, engName, pmName),             // client (designed)
        emailPMsEngineerAccepted(req, engName, pmName, pmEmails || []),// PM broadcast (designed)
        emailSuperAdminsEngineerAccepted(req, engName, pmName, superAdmins || []), // SA (designed)
      ]);
    } catch (e) {
      console.error("[mail] engineerAcceptsTask mail fanout failed:", e?.message);
    }
  })();

  // 🔴 Permanent system bubble (client-only)
  try {
    await saveAndEmitSystemForClients({
      roomId: req.chatRoom.toString(),
      text: "Engineer has accepted the task and will be joining the room.",
      kind: "engineer_accepted",
    });
  } catch {}

  await logAudit({
    action: "ENGINEER_ACCEPTED",
    actor: engineerUser._id,
    target: req._id,
    targetModel: "ProjectRequest",
    request: req._id,
    room: req.chatRoom,
    meta: auditMeta,
  });

  // In-app notifications
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

  // ✉️ EMAILS (fire-and-forget): Client + PMs + SuperAdmins get rich HTML
  (async () => {
    try {
      const [pmDoc, sas, pmEmails] = await Promise.all([
        req.pmAssigned ? User.findById(req.pmAssigned).lean() : null,
        getSuperAdmins(),
        getPMEmails(),
      ]);
      const pmName = pmDoc ? [pmDoc.firstName, pmDoc.lastName].filter(Boolean).join(" ") : "";
      const engName = [engineerUser?.firstName, engineerUser?.lastName].filter(Boolean).join(" ") || "Engineer";

      await Promise.allSettled([
        emailClientEngineerAccepted(req, engName, pmName || ""),
        emailPMsEngineerAccepted(req, engName, pmName || "", pmEmails || []),
        emailSuperAdminsEngineerAccepted(req, engName, pmName || "", sas || []),
      ]);
    } catch (e) {
      console.warn("[mail] engineerAccepted email flow failed:", e?.message);
    }
  })();

  return req;
};

export const markRequestReview = async (requestId, engineerUser, auditMeta = {}) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req) throw new Error("Request not found");
  if (!req.engineerAssigned?.equals(engineerUser._id)) throw new Error("Not your request");

  req.status = "Review";
  await req.save();

  // 🔴 Permanent system bubble (client-only): Engineer completed work (ready for review)
  try {
    await saveAndEmitSystemForClients({
      roomId: req.chatRoom.toString(),
      text: "Engineer has completed the task. The project is ready for review.",
      kind: "engineer_completed",
    });
  } catch {}

  try {
    getIO()?.to(req.chatRoom.toString()).emit("project:review", {
      requestId: req._id.toString(),
      status: "Review",
    });
  } catch {}

  await logAudit({
    action: "REQUEST_TO_REVIEW",
    actor: engineerUser._id,
    target: req._id,
    targetModel: "ProjectRequest",
    request: req._id,
    room: req.chatRoom,
    meta: auditMeta,
  });

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
  } catch {}

  await logAudit({
    action: "REQUEST_RATED",
    actor: null,
    target: req._id,
    targetModel: "ProjectRequest",
    request: req._id,
    room: req.chatRoom,
    meta: ratingPayload ? { ...ratingPayload, ...auditMeta } : auditMeta,
  });

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
  } catch {}

  await logAudit({
    action: "REQUEST_COMPLETED",
    actor: pmUser._id,
    target: req._id,
    targetModel: "ProjectRequest",
    request: req._id,
    room: req.chatRoom,
    meta: auditMeta,
  });

  // ✉️ Thank-you email to client (fire-and-forget)
  (async () => {
    try {
      await emailClientThankYou(req);
    } catch {}
  })();

  try {
    await notifySuperAdmins({
      type: "PROJECT_COMPLETED",
      title: "Project completed",
      body: `“${req.projectTitle || "Project"}” marked Complete`,
      link: links.adminProject(req._id),
      meta: { requestId: req._id },
    });
  } catch {}

  return req;
};

/** Client asks to reopen a closed room */
export const clientRequestsReopen = async (roomId, authUser, auditMeta = {}) => {
  const room = await ChatRoom.findById(roomId);
  if (!room) throw new Error("Room not found");

  const pr = await ProjectRequest.findOne({ chatRoom: room._id });
  if (!pr) throw new Error("Project not found for this room");

  const isMember =
    room.members?.some?.((m) => m.toString() === authUser._id.toString()) ||
    (pr.clientId && pr.clientId.toString() === authUser._id.toString());

  if (!isMember) throw new Error("Forbidden: not a member of this room");

  if (!room.isClosed) throw new Error("Room is not closed");

  if (!room.reopenRequestedByClient) {
    room.reopenRequestedByClient = true;
    await room.save();

    await logAudit({
      action: "CLIENT_REQUEST_REOPEN",
      actor: authUser._id || null,
      target: pr._id,
      targetModel: "ProjectRequest",
      request: pr._id,
      room: room._id,
      meta: auditMeta,
    });

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

export const reopenRoomAndResume = async (requestId, pmUser, auditMeta = {}) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req) throw new Error("Request not found");
  if (!req.pmAssigned?.equals(pmUser._id)) throw new Error("Only assigned PM can reopen");

  const room = req.chatRoom ? await ChatRoom.findById(req.chatRoom) : null;
  if (!room) throw new Error("Room not found");
  if (!room.isClosed) return req; // idempotent

  await room.updateOne({ $set: { isClosed: false, reopenRequestedByClient: false } });

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
  } catch {}

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
};
