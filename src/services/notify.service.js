import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { getIO } from "../lib/io.js";
import { sendMail as sendEmail } from "../lib/mailer.js";

export const links = {
  chat: () => "/chat",
  chatRoom: (_roomId) => "/chat",      // route list, not /chat/room/:id
  engineerTask: (_requestId) => "/tasks",
  adminProject: (_requestId) => "",    // SA doesn’t navigate
};

/**
 * Upsert a notification, emit over socket, and mirror as email.
 * Ensures a single (user,type,requestId,taskId) entry by unique index.
 */
export async function createAndEmit(userId, payload) {
  const filter = {
    user: userId,
    type: payload.type,
  };
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

  // Upsert prevents duplicates
  const doc = await Notification.findOneAndUpdate(filter, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  }).lean();

  // Socket ping
  try { getIO()?.to(`user:${userId.toString()}`).emit("notify:event", doc); } catch {}

  // Email mirror
  try {
    const u = await User.findById(userId).lean();
    if (u?.email) {
      const subject = payload.title || "Notification";
      const linkLine = payload.link ? `<p><a href="${payload.link}" target="_blank">Open</a></p>` : "";
      const html = `
        <div style="font-family:Inter,Arial,sans-serif;line-height:1.5">
          <h3 style="margin:0 0 8px">${subject}</h3>
          <p>${payload.body || ""}</p>
          ${linkLine}
          <hr/>
          <p style="color:#666;font-size:12px">You’re receiving this because you have a Loopp account.</p>
        </div>
      `;
      const text = `${payload.body || ""}\n${payload.link || ""}`.trim();
      await sendEmail({ to: u.email, subject, html, text });
    }
  } catch {}

  return doc;
}

/** Notify all SuperAdmins (and email them). */
export async function notifySuperAdmins(payload) {
  const superAdmins = await User.find({ role: /super\s*admin/i }, "_id email").lean();
  const results = [];
  for (const sa of superAdmins) {
    results.push(
      await createAndEmit(sa._id, {
        ...payload,
        link: "", // SA stays on dashboards
      })
    );
  }
  return results;
}
