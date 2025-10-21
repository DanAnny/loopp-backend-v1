// backend/src/services/notify.service.js
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { getIO } from "../lib/io.js";

export const links = {
  chat: () => "/chat",
  chatRoom: (_roomId) => "/chat",     // route list, not /chat/room/:id
  engineerTask: (_requestId) => "/tasks",
  adminProject: (_requestId) => "",    // SA doesn’t navigate
};

export async function createAndEmit(userId, payload) {
  const filter = {
    user: userId,
    type: payload.type,
  };
  // help the unique index kick in
  if (payload?.meta?.requestId) filter["meta.requestId"] = payload.meta.requestId;
  if (payload?.meta?.taskId)    filter["meta.taskId"]    = payload.meta.taskId;

  const update = {
    $setOnInsert: {
      user: userId,
      type: payload.type,
      title: payload.title,
      body: payload.body || "",
      link: payload.link || "",
      meta: payload.meta || {},
    },
  };

  // upsert prevents duplicates
  const doc = await Notification.findOneAndUpdate(filter, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  }).lean();

  try { getIO()?.to(`user:${userId.toString()}`).emit("notify:event", doc); } catch {}

  return doc;
}

export async function notifySuperAdmins(payload) {
  const superAdmins = await User.find({ role: /super\s*admin/i }, "_id").lean();
  const results = [];
  for (const sa of superAdmins) {
    results.push(
      await createAndEmit(sa._id, {
        ...payload,
        link: "", // SA should never navigate
      })
    );
  }
  return results;
}
