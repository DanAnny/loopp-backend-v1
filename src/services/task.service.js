// backend/src/services/task.service.js
import { Task } from "../models/Task.js";
import { ProjectRequest } from "../models/ProjectRequest.js";
import { ChatRoom } from "../models/ChatRoom.js";
import { User } from "../models/User.js";
import { logAudit } from "./audit.service.js";
import { getIO } from "../lib/io.js";
import mongoose from "mongoose";

/* 🔔 notifications */
import { createAndEmit, notifySuperAdmins, links } from "./notify.service.js";

// NEW: system inline emitter
import { emitSystem } from "../lib/events.js";

/** Parse 'YYYY-MM-DD' into a UTC Date (00:00:00). Returns null if invalid. */
function parseYmdToUtcDate(ymd) {
  if (!ymd || typeof ymd !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  return isFinite(dt) ? dt : null;
}

/* ---------------- PM creates the single task (assigns engineer too) -------- */
export const createTaskForRequest = async (
  { requestId, pmUser, engineerId, title, description, deadline, pmDeadline },
  auditMeta = {}
) => {
  const req = await ProjectRequest.findById(requestId);
  if (!req) throw new Error("Request not found");
  if (!req.pmAssigned?.equals(pmUser._id))
    throw new Error("Only assigned PM can create task");

  // single-engineer constraint
  if (req.engineerAssigned && !req.engineerAssigned.equals(engineerId))
    throw new Error("Request already has a different engineer");

  // enforce engineer assignment now
  req.engineerAssigned = engineerId;
  await req.save();

  // pick deadline from either `deadline` or `pmDeadline`
  const chosenDeadline =
    deadline
      ? parseYmdToUtcDate(deadline) || new Date(deadline)
      : pmDeadline
      ? parseYmdToUtcDate(pmDeadline)
      : null;

  // create task (Assigned/Pending)
  const task = await Task.create({
    request: req._id,
    pm: pmUser._id,
    engineer: engineerId,
    title,
    description,
    deadline: chosenDeadline || null,
  });

  // 🔵 INLINE NOTICE: PM HAS ASSIGNED THE PROJECT TO AN ENGINEER (First Last)
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
  } catch {}

  // ❌ Do NOT bump engineer workload on assignment.
  // Workload increments only when the engineer ACCEPTS the task.

  // ✅ persistent notification to the Engineer
  try {
    await createAndEmit(engineerId, {
      type: "ENGINEER_ASSIGNED",
      title: "You’ve been assigned a project",
      body: `“${req.projectTitle || "Project"}” by ${req.firstName} ${req.lastName}`,
      link: links.engineerTask(req._id),
      meta: { requestId: req._id, taskId: task._id },
    });
  } catch {}

  // ✅ heads-up for SuperAdmins
  try {
    await notifySuperAdmins({
      type: "ENGINEER_ASSIGNED",
      title: "Engineer assigned",
      body: `PM assigned an engineer for “${req.projectTitle || "Project"}”.`,
      link: "",
      meta: { requestId: req._id, taskId: task._id, engineerId },
    });
  } catch {}

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

  const alreadyInProgress =
    String(task.status || "").toLowerCase() === "inprogress";
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

  await logAudit({
    action: "TASK_ACCEPTED",
    actor: engineerUser._id,
    target: task._id,
    targetModel: "Task",
    request: task.request,
    room: req.chatRoom,
    meta: auditMeta,
  });

  // 🔵 INLINE NOTICE: ENGINEER HAS ACCEPTED...
  try {
    if (req.chatRoom) {
      emitSystem(req.chatRoom, {
        type: "engineer_accepted",
        role: "Engineer",
        engineer: { id: String(engineerUser._id), firstName: engineerUser.firstName || "", lastName: engineerUser.lastName || "" },
      });
    }
  } catch {}

  // 🔔 Notify PM & SuperAdmins (existing)
  try {
    if (req.pmAssigned) {
      await createAndEmit(req.pmAssigned, {
        type: "ENGINEER_ACCEPTED",
        title: "Engineer accepted the task",
        body: `Engineer accepted “${req.projectTitle || "Project"}”.`,
        link: links.chat(),
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
  } catch {}

  return { task, roomId, roomKey };
};

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

  await logAudit({
    action: "TASK_COMPLETED",
    actor: engineerUser._id,
    target: task._id,
    targetModel: "Task",
    request: task.request,
    room: req.chatRoom,
    meta: auditMeta,
  });

  // (Your existing review pushes/messages)
  if (movedToReview && req.chatRoom) {
    const roomId = req.chatRoom.toString();
    try {
      getIO()?.to(roomId).emit("project:review", {
        requestId: req._id.toString(),
        status: "Review",
      });
      getIO()?.to(roomId).emit("message", {
        _id: `${Date.now()}-${Math.random()}`,
        room: roomId,
        senderType: "System",
        senderRole: "PM",
        senderName: "System",
        text:
          "✅ Your project is ready for review. Please rate the PM, Engineer, and Teamwork so we can wrap up!",
        attachments: [],
        createdAt: new Date().toISOString(),
      });
    } catch {}
  }

  // (existing admin notifications)
  try {
    if (req.pmAssigned) {
      await createAndEmit(req.pmAssigned, {
        type: "STATUS_REVIEW",
        title: "Project moved to Review",
        body: `“${req.projectTitle || "Project"}” is ready for review.`,
        link: links.chat(),
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
  } catch {}

  return task;
};

// (unchanged) — reads
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
