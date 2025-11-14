import mongoose from "mongoose";

import { Task } from "../models/Task.js";
import { ProjectRequest } from "../models/ProjectRequest.js";
import { ChatRoom } from "../models/ChatRoom.js";
import { User } from "../models/User.js";
import { Message } from "../models/Message.js";

import { logAudit } from "./audit.service.js";
import { getIO } from "../lib/io.js";

// 🔔 in-app + socket notifications
import { createAndEmit, notifySuperAdmins, links } from "./notify.service.js";

// NEW: system inline emitter (room system bubbles)
import { emitSystem } from "../lib/events.js";

// ✉️ Rich HTML email templates
import {
  emailClientEngineerAssigned,
  emailClientEngineerAccepted,
  emailPMsEngineerAccepted,
  emailSuperAdminsEngineerAccepted,
  emailClientProjectSubmitted,
} from "./email.service.js";

/* ========================================================================== */
/*                               Utilities                                    */
/* ========================================================================== */

/** Coerce mixed inputs into a Date or null (end-of-day for YYYY-MM-DD). */
function coerceDeadline(v) {
  if (!v) return null;
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === "number") return new Date(v);

  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return new Date(`${s}T23:59:59.999Z`);
    }
    const d = new Date(s);
    if (!isNaN(d)) return d;
  }
  return null;
}

/**
 * Resolve client email using multiple fallbacks:
 * 1) request.email
 * 2) request.clientId → User.email
 * 3) any ChatRoom member with role "Client" and a valid email
 */
async function resolveClientEmailStrong(reqLean) {
  if (reqLean?.email && String(reqLean.email).trim()) return String(reqLean.email).trim();

  if (reqLean?.clientId) {
    try {
      const u = await User.findById(reqLean.clientId).select("email").lean();
      if (u?.email && String(u.email).trim()) return String(u.email).trim();
    } catch { /* noop */ }
  }

  if (reqLean?.chatRoom) {
    try {
      const room = await ChatRoom.findById(reqLean.chatRoom).select("members").lean();
      const ids = (room?.members || []).map(String);
      if (ids.length) {
        const candidates = await User.find({
          _id: { $in: ids },
          role: "Client",
          email: { $exists: true },
        }).select("email").lean();

        const hit = candidates.find(c => c?.email && String(c.email).trim());
        if (hit) return String(hit.email).trim();
      }
    } catch { /* noop */ }
  }

  return null;
}

/** Local helpers to avoid importing from project.service (prevents circular deps). */
async function getSuperAdmins() {
  return User.find({ role: { $in: ["SuperAdmin", "Admin"] }, email: { $exists: true } })
    .select("_id email firstName lastName")
    .lean();
}

async function getPMEmails() {
  const pms = await User.find({ role: /pm/i, email: { $exists: true } })
    .select("email")
    .lean();
  return pms.map(p => p.email).filter(Boolean);
}

/* ========================================================================== */
/*                            Core Task Flows                                 */
/* ========================================================================== */

/**
 * PM creates the single task for a request and assigns the engineer.
 * Sends rich HTML "Engineer Assigned" to the client when resolvable.
 */
export const createTaskForRequest = async (
  { requestId, pmUser, engineerId, title, description, deadline, pmDeadline },
  auditMeta = {}
) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req) throw new Error("Request not found");
  if (!req.pmAssigned?.equals(pmUser._id)) throw new Error("Only assigned PM can create task");

  // single-engineer constraint
  if (req.engineerAssigned && !req.engineerAssigned.equals(engineerId)) {
    throw new Error("Request already has a different engineer");
  }

  // enforce engineer assignment now
  req.engineerAssigned = engineerId;
  await req.save();

  // ✉️ Client: Engineer Assigned (rich HTML)
  try {
    const [pmDoc, engDoc] = await Promise.all([
      User.findById(pmUser._id).lean(),
      User.findById(engineerId).lean(),
    ]);
    const pmName  = [pmDoc?.firstName, pmDoc?.lastName].filter(Boolean).join(" ") || "PM";
    const engName = [engDoc?.firstName, engDoc?.lastName].filter(Boolean).join(" ") || "Engineer";

    const reqLean = await ProjectRequest.findById(req._id)
      .select("email clientId chatRoom firstName lastName projectTitle pmAssigned engineerAssigned")
      .lean();
    const clientEmail = await resolveClientEmailStrong(reqLean);

    if (clientEmail) {
      const r = await emailClientEngineerAssigned({ ...reqLean, email: clientEmail }, engName, pmName);
      console.log("[mail] EngineerAssigned → client:", { to: clientEmail, r });
    } else {
      console.warn("[mail] EngineerAssigned SKIPPED — no client email found", { requestId: String(req._id) });
    }
  } catch (e) {
    console.error("[mail] EngineerAssigned email error:", e?.message);
  }

  // pick deadline from either `deadline` or `pmDeadline`
  const chosenDeadline = coerceDeadline(deadline) ?? coerceDeadline(pmDeadline);

  // create task (Assigned/Pending)
  const task = await Task.create({
    request: req._id,
    pm: pmUser._id,
    engineer: engineerId,
    title,
    description,
    deadline: chosenDeadline || null,
  });

  // 🔵 INLINE system bubble in room
  try {
    if (req.chatRoom) {
      const eng = await User.findById(engineerId).lean();
      emitSystem(req.chatRoom, {
        type: "pm_assigned_engineer",
        role: "PM",
        engineer: eng
          ? { id: String(eng._id), firstName: eng.firstName || "", lastName: eng.lastName || "" }
          : { id: String(engineerId), firstName: "", lastName: "" },
      });
    }
  } catch { /* noop */ }

  // ✅ persistent notification to the Engineer
  try {
    await createAndEmit(engineerId, {
      type: "ENGINEER_ASSIGNED",
      title: "You’ve been assigned a project",
      body: `“${req.projectTitle || "Project"}” by ${req.firstName} ${req.lastName}`,
      link: links.engineerTask(req._id),
      meta: { requestId: req._id, taskId: task._id },
    });
  } catch { /* noop */ }

  // ✅ heads-up for SuperAdmins
  try {
    await notifySuperAdmins({
      type: "ENGINEER_ASSIGNED",
      title: "Engineer assigned",
      body: `PM assigned an engineer for “${req.projectTitle || "Project"}”.`,
      link: "",
      meta: { requestId: req._id, taskId: task._id, engineerId },
    });
  } catch { /* noop */ }

  await logAudit({
    action: "TASK_CREATED",
    actor: pmUser._id,
    target: task._id,
    targetModel: "Task",
    request: req._id,
    room: req.chatRoom,
    meta: {
      title,
      deadline: chosenDeadline ? chosenDeadline.toISOString() : null,
      viaParams: { deadline: !!deadline, pmDeadline: !!pmDeadline },
      ...auditMeta,
    },
  });

  return task;
};

/**
 * Engineer accepts the assigned task.
 * Sends rich HTML "Engineer Accepted" to the client (first), then PMs/Admins.
 */
export const engineerAcceptTask = async (taskId, engineerUser, auditMeta = {}) => {
  const task = await Task.findById(taskId);
  if (!task) throw new Error("Task not found");
  if (!task.engineer.equals(engineerUser._id)) throw new Error("Not your task");

  const req = await ProjectRequest.findById(task.request);
  if (!req) throw new Error("Request not found for task");

  // Add engineer to room on accept
  let roomKey = null;
  let roomId = null;
  if (req.chatRoom) {
    const room = await ChatRoom.findById(req.chatRoom);
    if (room) {
      await room.updateOne({ $addToSet: { members: engineerUser._id } });
      roomKey = room.roomKey || null;
      roomId = room._id.toString();
    }
  }

  // Status bookkeeping
  const alreadyInProgress = String(task.status || "").toLowerCase() === "inprogress";
  if (!alreadyInProgress) {
    await User.updateOne(
      { _id: engineerUser._id },
      { $inc: { numberOfTask: 1 }, $set: { isBusy: true } }
    );
    if (!req.__engineerAccepted) {
      req.__engineerAccepted = true;
    }
  }

  task.status = "InProgress";
  await task.save();

  if (req.status !== "InProgress") {
    req.status = "InProgress";
  }
  await req.save();

  // ---- HTML EMAIL FAN-OUT ---------------------------------------------------
  // Send CLIENT first so staff list errors never block client comms.
  try {
    const [pmDoc, engDoc] = await Promise.all([
      req.pmAssigned ? User.findById(req.pmAssigned).lean() : null,
      User.findById(engineerUser._id).lean(),
    ]);

    const pmName  = [pmDoc?.firstName, pmDoc?.lastName].filter(Boolean).join(" ") || "";
    const engName = [engDoc?.firstName, engDoc?.lastName].filter(Boolean).join(" ") || "Engineer";

    const reqLean = await ProjectRequest.findById(req._id)
      .select("email clientId chatRoom firstName lastName projectTitle pmAssigned engineerAssigned")
      .lean();

    const clientEmail = await resolveClientEmailStrong(reqLean);

    if (clientEmail) {
      await emailClientEngineerAccepted({ ...reqLean, email: clientEmail }, engName, pmName);
    } else {
      console.warn("[mail] EngineerAccepted SKIPPED — no client email found", {
        requestId: String(req._id),
      });
    }

    // PMs + SuperAdmins (do NOT block client)
    (async () => {
      try {
        const [superAdmins, pmEmails] = await Promise.all([
          getSuperAdmins(),
          getPMEmails(),
        ]);

        await Promise.allSettled([
          emailPMsEngineerAccepted(req, engName, pmName, pmEmails || []),
          emailSuperAdminsEngineerAccepted(req, engName, pmName, superAdmins || []),
        ]);
      } catch (e) {
        console.error("[mail] EngineerAccepted staff email error:", e?.message);
      }
    })();

  } catch (e) {
    console.error("[mail] EngineerAccepted email error:", e?.message);
  }
  // ---------------------------------------------------------------------------

  await logAudit({
    action: "TASK_ACCEPTED",
    actor: engineerUser._id,
    target: task._id,
    targetModel: "Task",
    request: task.request,
    room: req.chatRoom,
    meta: auditMeta,
  });

  // 🔵 INLINE system bubble
  try {
    if (req.chatRoom) {
      emitSystem(req.chatRoom, {
        type: "engineer_accepted",
        role: "Engineer",
        engineer: {
          id: String(engineerUser._id),
          firstName: engineerUser.firstName || "",
          lastName: engineerUser.lastName || "",
        },
      });
    }
  } catch { /* noop */ }

  // 🔔 In-app notifications to PM & SuperAdmins
  try {
    if (req.pmAssigned) {
      await createAndEmit(req.pmAssigned, {
        type: "ENGINEER_ACCEPTED",
        title: "Engineer accepted the task",
        body: `Engineer accepted “${req.projectTitle || "Project"}”.`,
        // If your app has links.chatRoom(roomId) prefer that; keeping links.chat() to match your prior usage
        link: links.chat?.() || links.chatRoom?.(roomId) || "",
        meta: { requestId: req._id, taskId: task._id, roomId },
      });
    }
    await notifySuperAdmins({
      type: "ENGINEER_ACCEPTED",
      title: "Engineer accepted",
      body: `Engineer accepted “${req.projectTitle || "Project"}”.`,
      link: "",
      meta: { requestId: req._id, taskId: task._id, engineerId: engineerUser._id },
    });
  } catch { /* noop */ }

  return { task, roomId, roomKey };
};

/**
 * Engineer completes the task → move request to Review (if not already),
 * drop a system message, and notify PM + SuperAdmins.
 */
export const engineerCompleteTask = async (taskId, engineerUser, auditMeta = {}) => {
  const task = await Task.findById(taskId);
  if (!task) throw new Error("Task not found");
  if (!task.engineer.equals(engineerUser._id)) throw new Error("Not your task");

  task.status = "Complete";
  await task.save();

  const req = await ProjectRequest.findById(task.request);
  if (!req) throw new Error("Request not found for task");

  let movedToReview = false;
  if (req.status !== "Review" && req.status !== "Complete") {
    req.status = "Review";
    await req.save();
    movedToReview = true;
  }

  try {
    const [pmDoc, engDoc] = await Promise.all([
      req.pmAssigned ? User.findById(req.pmAssigned).lean() : null,
      req.engineerAssigned ? User.findById(req.engineerAssigned).lean() : null,
    ]);
    const pmName  = [pmDoc?.firstName, pmDoc?.lastName].filter(Boolean).join(" ") || "PM";
    const engName = [engDoc?.firstName, engDoc?.lastName].filter(Boolean).join(" ") || "Engineer";

    const reqLean = await ProjectRequest.findById(req._id)
      .select("email clientId chatRoom firstName lastName projectTitle pmAssigned engineerAssigned")
      .lean();
    const clientEmail = await resolveClientEmailStrong(reqLean);

    if (clientEmail) {
      await emailClientProjectSubmitted({ ...reqLean, email: clientEmail }, pmName, engName);
      console.log("[mail] Submitted→Review → client:", { to: clientEmail });
    } else {
      console.warn("[mail] Submitted→Review SKIPPED — no client email found", {
        requestId: String(req._id),
      });
    }
  } catch (e) {
    console.error("[mail] Submitted→Review email error:", e?.message);
  }

  await logAudit({
    action: "TASK_COMPLETED",
    actor: engineerUser._id,
    target: task._id,
    targetModel: "Task",
    request: task.request,
    room: req.chatRoom,
    meta: auditMeta,
  });

  // 🔔 Notify chat room and persist inline system notice
  if (movedToReview && req.chatRoom) {
    const roomId = req.chatRoom.toString();
    try {
      getIO()?.to(roomId).emit("project:review", {
        requestId: req._id.toString(),
        status: "Review",
      });

      const text =
        "---- Project has been submitted for review ----";
      const msg = await Message.create({
        room: roomId,
        senderType: "System",
        sender: null,
        text,
        attachments: [],
      });
      getIO()?.to(roomId).emit("message", {
        _id: msg._id,
        room: roomId,
        senderType: "System",
        senderRole: "PM",
        senderName: "System",
        text,
        attachments: [],
        createdAt: msg.createdAt,
      });
    } catch { /* noop */ }
  }

  // Persistent notifications
  try {
    if (req.pmAssigned) {
      await createAndEmit(req.pmAssigned, {
        type: "STATUS_REVIEW",
        title: "Project moved to Review",
        body: `“${req.projectTitle || "Project"}” is ready for review.`,
        link: links.chat?.() || links.chatRoom?.(req.chatRoom?.toString?.()) || "",
        meta: { requestId: req._id, taskId: task._id, roomId: req.chatRoom },
      });
    }
    await notifySuperAdmins({
      type: "STATUS_REVIEW",
      title: "Project in Review",
      body: `“${req.projectTitle || "Project"}” moved to Review.`,
      link: "",
      meta: { requestId: req._id, taskId: task._id },
    });
  } catch { /* noop */ }

  return task;
};

/* ========================================================================== */
/*                                Reads / Stats                               */
/* ========================================================================== */

export const getTasksForEngineer = async (engineerId) => {
  return Task.find({ engineer: engineerId }).sort({ createdAt: -1 }).lean();
};

const prettyStatus = (s = "") => {
  if (/^in[-_\s]*progress$/i.test(s)) return "In Progress";
  if (/^complete(d)?$/i.test(s)) return "Completed";
  if (/^assign(ed)?|pending$/i.test(s)) return "Assigned";
  return s;
};

export const getEngineerTaskSummary = async (engineerId) => {
  if (!mongoose.isValidObjectId(engineerId)) throw new Error("Invalid engineerId");
  const _id = new mongoose.Types.ObjectId(engineerId);

  const rows = await Task.aggregate([
    { $match: { engineer: _id } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);

  const counts = { Assigned: 0, "In Progress": 0, Completed: 0, Other: 0 };
  for (const r of rows) {
    const label = prettyStatus(String(r._id || ""));
    if (counts[label] == null) counts.Other += r.count;
    else counts[label] += r.count;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { ...counts, total };
};
