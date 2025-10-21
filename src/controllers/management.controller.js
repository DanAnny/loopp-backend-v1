// controllers/management.controller.js
import { User } from "../models/User.js";
import { Task } from "../models/Task.js";
import { ProjectRequest } from "../models/ProjectRequest.js";
import { logAudit } from "../services/audit.service.js";

const safeRole = (r) => (r || "").toString();

const canChangeRole = (actorRole, target, newRole) => {
  const isSuper = safeRole(target.role) === "SuperAdmin" || newRole === "SuperAdmin";
  if (isSuper) return false; // never change/create superadmin

  // Admin cannot grant Admin role nor edit Admins' role
  if (actorRole === "Admin") {
    if (newRole === "Admin") return false;
    if (safeRole(target.role) === "Admin") return false;
  }
  return true;
};

export const overview = async (req, res) => {
  try {
    // Staff numbers
    const [total, pms, engs, admins] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: "PM" }),
      User.countDocuments({ role: "Engineer" }),
      User.countDocuments({ role: "Admin" }),
    ]);

    const [pmActive, pmIdle, engActive, engIdle] = await Promise.all([
      User.countDocuments({ role: "PM", $or: [{ isBusy: true }, { online: true }] }),
      User.countDocuments({ role: "PM", isBusy: false, online: false }),
      User.countDocuments({ role: "Engineer", $or: [{ isBusy: true }, { online: true }] }),
      User.countDocuments({ role: "Engineer", isBusy: false, online: false }),
    ]);

    // Open vs in-progress vs completed for quick health
    const [reqOpen, reqProgress, reqComplete] = await Promise.all([
      ProjectRequest.countDocuments({ status: { $in: ["New", "Assigned"] } }),
      ProjectRequest.countDocuments({ status: { $in: ["In-Progress", "Review"] } }),
      ProjectRequest.countDocuments({ status: "Complete" }),
    ]);

    // Top busy users (by active tasks)
    const topBusy = await User.find({})
      .select("firstName lastName role email numberOfTask isBusy online")
      .sort({ numberOfTask: -1 })
      .limit(6)
      .lean();

    res.json({
      success: true,
      data: {
        staff: {
          total,
          pms,
          engs,
          admins,
          pmActive,
          pmIdle,
          engActive,
          engIdle,
        },
        projects: {
          open: reqOpen,
          inProgress: reqProgress,
          completed: reqComplete,
        },
        topBusy,
      },
    });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

export const recentAudits = async (req, res) => {
  try {
    // assume you have an Audit model inside audit.service or models/Audit.js
    const { AuditLog } = await import("../models/AuditLog.js"); // dynamic to avoid import cycles
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const audits = await AuditLog.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ success: true, audits });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

// quick toggle busy/online/active for a single user
export const quickToggleUser = async (req, res) => {
  try {
    const actor = req.user;
    const { id } = req.params;
    const { isBusy, online, isActive } = req.body || {};

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    // role protections
    if (safeRole(user.role) === "SuperAdmin") {
      return res.status(403).json({ success: false, message: "Forbidden: SuperAdmin protected" });
    }

    if (typeof isBusy === "boolean") user.isBusy = isBusy;
    if (typeof online === "boolean") user.online = online;
    if (typeof isActive === "boolean") user.isActive = isActive;

    await user.save();

    await logAudit({
      action: "USER_TOGGLED",
      actor: actor._id,
      target: user._id,
      targetModel: "User",
      meta: { isBusy, online, isActive },
    });

    res.json({ success: true, user: sanitize(user.toObject()) });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

// Bulk update – set Busy/Online/Active and (optionally) Role for many users
export const bulkUpdateUsers = async (req, res) => {
  try {
    const actor = req.user;
    const actorRole = safeRole(actor.role);

    const { ids = [], patch = {} } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: "No user ids" });
    }

    // allowed patchable fields
    const next = {};
    if (typeof patch.isBusy === "boolean") next.isBusy = patch.isBusy;
    if (typeof patch.online === "boolean") next.online = patch.online;
    if (typeof patch.isActive === "boolean") next.isActive = patch.isActive;

    const roleChange = patch.role ? safeRole(patch.role) : null;

    const users = await User.find({ _id: { $in: ids } }).lean();
    const goodIds = [];

    for (const u of users) {
      if (safeRole(u.role) === "SuperAdmin") continue; // skip
      if (roleChange) {
        if (!canChangeRole(actorRole, u, roleChange)) continue;
      }
      goodIds.push(u._id);
    }

    if (!goodIds.length) {
      return res.json({ success: true, changed: 0 });
    }

    // apply partial fields
    const update = { ...next };
    if (roleChange) update.role = roleChange;

    const result = await User.updateMany({ _id: { $in: goodIds } }, { $set: update });

    await logAudit({
      action: "USER_BULK_UPDATED",
      actor: actor._id,
      targetModel: "User",
      meta: { ids: goodIds, update },
    });

    res.json({ success: true, changed: result.modifiedCount || 0 });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

function sanitize(u) {
  const { password, salt, hash, ...rest } = u;
  return rest;
}
