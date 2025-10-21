import { Notification } from "../models/Notification.js";

/** GET /api/notifications?cursor=&limit= */
export const listMyNotifications = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    const cursor = req.query.cursor || null;

    const query = { user: req.user._id };
    if (cursor) query._id = { $lt: cursor }; // paginate by id

    const items = await Notification.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();

    const nextCursor = items.length > limit ? String(items[limit]._id) : null;
    const data = items.slice(0, limit).map((n) => ({
      _id: String(n._id),
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link || "",
      meta: n.meta || {},
      createdAt: n.createdAt,
      readAt: n.readAt,
    }));

    res.json({ success: true, notifications: data, nextCursor });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

/** POST /api/notifications/read { id } */
export const markRead = async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, message: "Missing id" });

    const n = await Notification.findOne({ _id: id, user: req.user._id });
    if (!n) return res.status(404).json({ success: false, message: "Not found" });

    if (!n.readAt) {
      n.readAt = new Date();
      await n.save();
    }

    res.json({ success: true, notification: { _id: String(n._id), readAt: n.readAt } });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};

/** POST /api/notifications/read-all */
export const markAllRead = async (req, res) => {
  try {
    await Notification.updateMany({ user: req.user._id, readAt: null }, { $set: { readAt: new Date() } });
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
};
