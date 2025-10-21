// backend/src/controllers/project.controller.js
import * as projectService from "../services/project.service.js";
import { fromReq } from "../services/audit.service.js";
import { getIO } from "../lib/io.js";
import { ProjectRequest } from "../models/ProjectRequest.js";
import { User } from "../models/User.js";
import { ChatRoom } from "../models/ChatRoom.js";
import { Task } from "../models/Task.js";

/* ========================================================================== */
/* helpers */
/* ========================================================================== */

function prettyStatus(s = "") {
  return { InProgress: "In-Progress" }[s] || s;
}

function attachPeopleNames(p) {
  const pm = p.pmAssigned && typeof p.pmAssigned === "object" ? p.pmAssigned : null;
  const eng = p.engineerAssigned && typeof p.engineerAssigned === "object" ? p.engineerAssigned : null;

  const pmName = pm ? `${pm.firstName || ""} ${pm.lastName || ""}`.trim() : null;
  const engineerName = eng ? `${eng.firstName || ""} ${eng.lastName || ""}`.trim() : null;

  return {
    ...p,
    status: prettyStatus(p.status),
    pmName,
    engineerName,
    pmAssigned: pm ? pm._id : p.pmAssigned,
    engineerAssigned: eng ? eng._id : p.engineerAssigned,
  };
}

/** pick a representative task for a request (latest updated) */
function pickRepresentativeTask(tasksForRequest) {
  if (!tasksForRequest || tasksForRequest.length === 0) return null;
  return tasksForRequest
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt) || new Date(b.createdAt) - new Date(a.createdAt))[0];
}

/* ========================================================================== */
/* INTAKE / BASICS */
/* ========================================================================== */

export const intakeFromWordPress = async (req, res) => {
  try {
    const src = req.body || {};
    console.log("WP Intake:", src);
    const {
      firstName,
      lastName,
      email,
      projectTitle,
      projectDescription,
      completionDate,
      clientKey,
    } = src;

    const missing = [];
    if (!firstName) missing.push("firstName");
    if (!lastName) missing.push("lastName");
    if (!email) missing.push("email");
    if (!projectDescription) missing.push("projectDescription");
    if (!completionDate) missing.push("completionDate");
    if (missing.length) {
      return res.status(400).json({ success: false, message: `Missing: ${missing.join(", ")}` });
    }

    // Note: clientId is not known at this point (anonymous WP intake)
    const { request, pm, room } = await projectService.createProjectRequestAndAssignPM(
      { firstName, lastName, email, projectTitle, projectDescription, completionDate, clientKey },
      fromReq(req)
    );

    res.status(201).json({
      success: true,
      requestId: request._id,
      chatRoomId: room?._id || null,
      roomKey: room?.roomKey || null,
      clientKey: request.clientKey,
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const listProjects = async (req, res) => {
  try {
    const q = {};
    if (req.user?.role === "PM") q.pmAssigned = req.user._id;

    const items = await ProjectRequest.find(q).sort({ updatedAt: -1 }).lean();

    // Pull tasks for these requests and enrich with taskDeadline
    const ids = items.map(i => i._id);
    const tasks = await Task.find({ request: { $in: ids } })
      .select("request deadline status updatedAt createdAt")
      .lean();

    const byReq = new Map();
    for (const t of tasks) {
      const k = String(t.request);
      if (!byReq.has(k)) byReq.set(k, []);
      byReq.get(k).push(t);
    }

    const enriched = items.map((p) => {
      const rep = pickRepresentativeTask(byReq.get(String(p._id)) || []);
      return {
        ...p,
        status: prettyStatus(p.status),
        taskDeadline: rep?.deadline ?? null,     // <- use this on the frontend
        taskStatus:   rep?.status   ?? null,
        taskUpdatedAt:rep?.updatedAt ?? null,
      };
    });

    res.json({ success: true, projects: enriched });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getProjectById = async (req, res) => {
  try {
    const item = await ProjectRequest.findById(req.params.id).lean();
    if (!item) return res.status(404).json({ success: false, message: "Not found" });
    if (req.user?.role === "PM" && item.pmAssigned?.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: "Forbidden" });

    const tasks = await Task.find({ request: item._id })
      .select("request deadline status updatedAt createdAt")
      .lean();
    const rep = pickRepresentativeTask(tasks);

    // add reopen flag from room if exists
    let reopenRequested = false;
    if (item.chatRoom) {
      const r = await ChatRoom.findById(item.chatRoom).lean();
      reopenRequested = !!r?.reopenRequestedByClient;
    }

    res.json({
      success: true,
      project: {
        ...item,
        status: prettyStatus(item.status),
        taskDeadline: rep?.deadline ?? null,
        taskStatus: rep?.status ?? null,
        taskUpdatedAt: rep?.updatedAt ?? null,
        reopenRequested, // ✅
      },
      tasks,
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

/* ========================================================================== */
/* ASSIGN / ACCEPT / REVIEW / RATE / CLOSE / REOPEN */
/* ========================================================================== */

export const assignEngineer = async (req, res) => {
  try {
    const { requestId, engineerId } = req.body;
    const updated = await projectService.setEngineerForRequest(requestId, engineerId, req.user, fromReq(req));
    res.json({ success: true, request: updated });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const engineerAccept = async (req, res) => {
  try {
    const { requestId } = req.body;
    const updated = await projectService.engineerAcceptsTask(requestId, req.user, fromReq(req));
    res.json({ success: true, request: updated });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const engineerMarkRequestReview = async (req, res) => {
  try {
    const { requestId } = req.body;
    const updated = await projectService.markRequestReview(requestId, req.user, fromReq(req));
    res.json({ success: true, request: updated });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const rateRequest = async (req, res) => {
  try {
    const {
      requestId,
      pmScore,
      pmComment,
      engineerScore,
      engineerComment,
      coordinationScore,
      coordinationComment,
    } = req.body;
    const updated = await projectService.rateAndComplete(
      requestId,
      { pmScore, pmComment, engineerScore, engineerComment, coordinationScore, coordinationComment },
      fromReq(req)
    );
    const reqDoc = await ProjectRequest.findById(requestId).lean();
    if (reqDoc?.chatRoom) {
      getIO()?.to(reqDoc.chatRoom.toString()).emit("rated", {
        requestId: requestId,
        ratings: updated.ratings || {},
      });
    }
    res.json({ success: true, request: updated });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const pmCloseRequest = async (req, res) => {
  try {
    const { requestId } = req.body;
    const updated = await projectService.closeRoomAndComplete(requestId, req.user, fromReq(req));

    if (updated?.chatRoom) {
      getIO()?.to(updated.chatRoom.toString()).emit("room:closed", {
        roomId: updated.chatRoom.toString(),
        at: new Date().toISOString(),
      });
    }

    res.json({ success: true, request: updated });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const pmReopenRequest = async (req, res) => {
  try {
    const { requestId } = req.body;
    const updated = await projectService.reopenRoomAndResume(requestId, req.user, fromReq(req));

    if (updated?.chatRoom) {
      getIO()?.to(updated.chatRoom.toString()).emit("room:reopened", {
        roomId: updated.chatRoom.toString(),
        at: new Date().toISOString(),
      });
    }

    res.json({ success: true, request: updated });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

/** ✅ NEW: Client action to request reopen */
// export const clientRequestReopen = async (req, res) => {
//   try {
//     const { roomId, requestId } = req.body || {};
//     let rid = roomId;

//     // allow either roomId or requestId
//     if (!rid && requestId) {
//       const pr = await ProjectRequest.findById(requestId).lean();
//       if (!pr?.chatRoom) return res.status(400).json({ success: false, message: "No room for this request" });
//       rid = pr.chatRoom.toString();
//     }

//     if (!rid) return res.status(400).json({ success: false, message: "roomId or requestId is required" });

//     const { room, project } = await projectService.clientRequestsReopen(rid, req.user, fromReq(req));

//     res.json({
//       success: true,
//       room: { id: room._id, isClosed: !!room.isClosed, reopenRequestedByClient: !!room.reopenRequestedByClient },
//       project: { id: project._id, status: project.status },
//       message: "Reopen request sent to your PM.",
//     });
//   } catch (e) {
//     res.status(400).json({ success: false, message: e.message });
//   }
// };

/* ========================================================================== */
/* DASH OVERVIEW */
/* ========================================================================== */

export const overview = async (req, res) => {
  try {
    const { range = "month" } = req.query; // currently unused, kept for compatibility
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const match = { createdAt: { $gte: start, $lte: end } };
    if (req.user?.role === "PM") match.pmAssigned = req.user._id;

    const thisMonthCount = await ProjectRequest.countDocuments(match);
    const completedThisMonth = await ProjectRequest.countDocuments({
      ...(req.user?.role === "PM" ? { pmAssigned: req.user._id } : {}),
      status: "Complete",
      updatedAt: { $gte: start, $lte: end },
    });

    res.json({ success: true, thisMonth: { projects: thisMonthCount, completed: completedThisMonth } });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

/* ========================================================================== */
/* NAMED VARIANTS & OPEN META */
/* ========================================================================== */

export const listProjectsNamed = async (req, res) => {
  try {
    const q = {};
    if (req.user?.role === "PM") q.pmAssigned = req.user._id;

    const items = await ProjectRequest.find(q)
      .sort({ updatedAt: -1 })
      .populate("pmAssigned", "firstName lastName email role")
      .populate("engineerAssigned", "firstName lastName email role")
      .lean();

    // also attach representative task deadline
    const ids = items.map(i => i._id);
    const tasks = await Task.find({ request: { $in: ids } })
      .select("request deadline status updatedAt createdAt")
      .lean();

    const byReq = new Map();
    for (const t of tasks) {
      const k = String(t.request);
      if (!byReq.has(k)) byReq.set(k, []);
      byReq.get(k).push(t);
    }

    // include reopen flags from room
    const rooms = await ChatRoom.find({ request: { $in: ids } }, "_id request reopenRequestedByClient").lean();
    const roomFlagMap = new Map(rooms.map(r => [String(r.request), !!r.reopenRequestedByClient]));

    const withPeople = items.map(attachPeopleNames).map(p => {
      const rep = pickRepresentativeTask(byReq.get(String(p._id)) || []);
      return {
        ...p,
        taskDeadline: rep?.deadline ?? null,
        taskStatus: rep?.status ?? null,
        taskUpdatedAt: rep?.updatedAt ?? null,
        reopenRequested: roomFlagMap.get(String(p._id)) || false,
      };
    });

    res.json({ success: true, projects: withPeople });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getProjectByIdNamed = async (req, res) => {
  try {
    const item = await ProjectRequest.findById(req.params.id)
      .populate("pmAssigned", "firstName lastName email role")
      .populate("engineerAssigned", "firstName lastName email role")
      .lean();
    if (!item) return res.status(404).json({ success: false, message: "Not found" });

    if (req.user?.role === "PM" && item.pmAssigned?._id?.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: "Forbidden" });

    const tasks = await Task.find({ request: item._id })
      .select("request deadline status updatedAt createdAt")
      .lean();
    const rep = pickRepresentativeTask(tasks);

    // reopen flag
    let reopenRequested = false;
    if (item.chatRoom) {
      const r = await ChatRoom.findById(item.chatRoom).lean();
      reopenRequested = !!r?.reopenRequestedByClient;
    }

    res.json({
      success: true,
      project: {
        ...attachPeopleNames(item),
        taskDeadline: rep?.deadline ?? null,
        taskStatus: rep?.status ?? null,
        taskUpdatedAt: rep?.updatedAt ?? null,
        reopenRequested,
      },
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getProjectByRoomNamed = async (req, res) => {
  try {
    const { roomId } = req.params;
    const pr = await ProjectRequest.findOne({ chatRoom: roomId })
      .populate("pmAssigned", "firstName lastName email role")
      .populate("engineerAssigned", "firstName lastName email role")
      .lean();

    if (!pr) return res.status(404).json({ success: false, message: "Not found" });
    if (req.user?.role === "PM" && pr.pmAssigned?._id?.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: "Forbidden" });

    const tasks = await Task.find({ request: pr._id })
      .select("request deadline status updatedAt createdAt")
      .lean();
    const rep = pickRepresentativeTask(tasks);

    const room = await ChatRoom.findById(roomId).lean();

    res.json({
      success: true,
      project: {
        ...attachPeopleNames(pr),
        taskDeadline: rep?.deadline ?? null,
        taskStatus: rep?.status ?? null,
        taskUpdatedAt: rep?.updatedAt ?? null,
        reopenRequested: !!room?.reopenRequestedByClient, // ✅
      },
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

/**
 * 🔓 OPEN: GET /projects/by-room/:roomId/meta
 * No authorization. Returns minimal meta if room exists.
 */
export const getRoomMeta = async (req, res) => {
  try {
    const { roomId } = req.params;

    const room = await ChatRoom.findById(roomId).lean();
    if (!room) return res.status(404).json({ success: false, message: "Room not found" });

    const pr = await ProjectRequest.findOne({ chatRoom: room._id }).lean();

    return res.json({
      success: true,
      room: { id: room._id, isClosed: !!room.isClosed, reopenRequestedByClient: !!room.reopenRequestedByClient },
      project: {
        id: pr?._id || null,
        status: pr?.status || null,
        hasRatings: !!(
          pr?.ratings &&
          (pr.ratings.pm?.score || pr.ratings.engineer?.score || pr.ratings.coordination?.score)
        ),
      },
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getByClientKey = async (req, res) => {
  try {
    const { clientKey } = req.params;
    const pr = await ProjectRequest.findOne({ clientKey }).lean();
    if (!pr) return res.status(404).json({ success: false, message: "Not found" });

    let room = null;
    if (pr.chatRoom) {
      room = await ChatRoom.findById(pr.chatRoom).lean();
    }

    res.json({
      success: true,
      project: {
        id: pr._id,
        firstName: pr.firstName,
        lastName: pr.lastName,
        email: pr.email,
        title: pr.projectTitle,
        status: pr.status,
      },
      chatRoom: room
        ? {
            id: room._id,
            title: room.title,
            isClosed: !!room.isClosed,
            roomKey: room.roomKey || null,
            reopenRequestedByClient: !!room.reopenRequestedByClient, // ✅
          }
        : null,
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const createFromClient = async (req, res) => {
  try {
    const {
      clientKey,
      projectTitle = "",
      firstName = "",
      lastName = "",
      email = "",
      projectDescription = "",
      completionDate = "",
    } = req.body || {};

    const isPlaceholder = (v) =>
      typeof v === "string" && (/%[A-Za-z0-9_]+%/.test(v) || /^\{.*\}$/.test(v));

    if (!clientKey || isPlaceholder(clientKey))
      return res.status(400).json({ success: false, message: "Valid clientKey is required" });

    const me = req.user;

    // If a request with this clientKey already exists, CLAIM it for this user and ensure membership
    const existing = await ProjectRequest.findOne({ clientKey }).lean();
    if (existing) {
      // If this PR is not owned by the current user, or has no owner, set owner to current user
      const shouldClaim =
        !existing.clientId ||
        existing.clientId.toString() !== me._id.toString();

      if (shouldClaim) {
        await ProjectRequest.updateOne(
          { _id: existing._id },
          {
            $set: {
              clientId: me._id,
              // backfill identity fields only if empty
              firstName: existing.firstName || me.firstName || firstName || "",
              lastName: existing.lastName || me.lastName || lastName || "",
              email: existing.email || me.email || email || "",
            },
          }
        );
      }

      // If a room already exists, make sure the current user is a member
      if (existing.chatRoom) {
        await ChatRoom.updateOne(
          { _id: existing.chatRoom },
          { $addToSet: { members: me._id } }
        );
      }

      return res.json({
        success: true,
        message: "Already exists",
        requestId: existing._id,
        chatRoomId: existing.chatRoom || null,
        clientKey: existing.clientKey,
      });
    }

    // No existing PR — create a new one with the authenticated client as owner
    const payload = {
      firstName: firstName || me.firstName || "",
      lastName: lastName || me.lastName || "",
      email: me?.email || email || "",
      projectTitle: projectTitle || "",
      projectDescription: projectDescription || "",
      completionDate: completionDate || "",
      clientKey,
      clientId: me?._id || null,
    };

    const missing = [];
    ["firstName", "lastName", "email", "projectDescription", "completionDate"].forEach((k) => {
      if (!payload[k] || isPlaceholder(payload[k])) missing.push(k);
    });
    if (missing.length) {
      return res.status(400).json({ success: false, message: `Missing: ${missing.join(", ")}` });
    }

    const { request, room } = await projectService.createProjectRequestAndAssignPM(payload, fromReq(req));

    return res.status(201).json({
      success: true,
      requestId: request._id,
      chatRoomId: room?._id || null,
      clientKey: request.clientKey,
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const getProjectByRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const pr = await ProjectRequest.findOne({ chatRoom: roomId }).lean();
    if (!pr) return res.status(404).json({ success: false, message: "Not found" });

    if (req.user?.role === "PM" && pr.pmAssigned?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    // include representative task deadline for parity with other endpoints
    const tasks = await Task.find({ request: pr._id })
      .select("request deadline status updatedAt createdAt")
      .lean();
    const rep = pickRepresentativeTask(tasks);

    const room = await ChatRoom.findById(roomId).lean();

    res.json({
      success: true,
      project: {
        ...pr,
        status: prettyStatus(pr.status),
        taskDeadline: rep?.deadline ?? null,
        taskStatus: rep?.status ?? null,
        taskUpdatedAt: rep?.updatedAt ?? null,
        reopenRequested: !!room?.reopenRequestedByClient, // ✅
      },
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const clientRequestReopen = async (req, res) => {
  try {
    const { roomId, requestId } = req.body || {};
    let rid = roomId;

    // allow either roomId or requestId
    if (!rid && requestId) {
      const pr = await ProjectRequest.findById(requestId).lean();
      if (!pr?.chatRoom) return res.status(400).json({ success: false, message: "No room for this request" });
      rid = pr.chatRoom.toString();
    }

    if (!rid) return res.status(400).json({ success: false, message: "roomId or requestId is required" });

    const { room, project } = await projectService.clientRequestsReopen(rid, req.user, fromReq(req));

    res.json({
      success: true,
      room: { id: room._id, isClosed: !!room.isClosed, reopenRequestedByClient: !!room.reopenRequestedByClient },
      project: { id: project._id, status: project.status },
      message: "Reopen request sent to your PM.",
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
