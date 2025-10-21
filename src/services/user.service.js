import { User } from "../models/User.js";
import { logAudit } from "./audit.service.js";

// Admin OR SuperAdmin can add PM/Engineer (NOT SuperAdmin)
export const adminAddStaff = async ({ creator, email, role, phone, firstName, lastName, gender }, auditMeta = {}) => {
  if (!["PM", "Engineer"].includes(role)) throw new Error("Admins can only add PM or Engineer");
  const user = new User({ email, phone, firstName, lastName, gender, role });
  await User.register(user, phone);

  await logAudit({
    action: "USER_CREATED",
    actor: creator._id,
    target: user._id,
    targetModel: "User",
    meta: { role, email, ...auditMeta },
  });

  return user;
};

export const listEngineers = async (
  { isBusy },
  select = "firstName lastName email role isBusy numberOfTask lastActive online"
) => {
  const query = { role: "Engineer" };
  if (typeof isBusy !== "undefined") query.isBusy = isBusy;
  return User.find(query).select(select).lean();
};

export const listPMs = async (
  { isBusy },
  select = "firstName lastName email role isBusy numberOfTask lastActive online"
) => {
  const query = { role: "PM" };
  if (typeof isBusy !== "undefined") query.isBusy = isBusy;
  return User.find(query).select(select).lean();
};

/* ------------------- ADDED HELPERS (keep existing above) ------------------- */

/** Minimal lookup for a single user id (names + role) */
export const getMinimalById = async (id) => {
  if (!id) return null;
  return User.findById(id).select("firstName lastName role").lean();
};

/** Minimal lookup for many user ids; returns { list, map } */
export const getMinimalByIds = async (ids = []) => {
  const uniq = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!uniq.length) return { list: [], map: new Map() };
  const users = await User.find({ _id: { $in: uniq } })
    .select("firstName lastName role")
    .lean();
  const map = new Map(users.map((u) => [String(u._id), u]));
  return { list: users, map };
};

export const listAllUsers = async () => {
  return User.find({}).select("firstName lastName email role isBusy numberOfTask lastActive online").lean();
}
