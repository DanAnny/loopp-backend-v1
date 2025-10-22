// backend/src/lib/events.js
import { getIO } from "./io.js";

/** Emit a system inline notice to a room (client shows dashed inline) */
export const emitSystem = (roomId, payload = {}) => {
  try {
    const io = getIO();
    if (!io || !roomId) return;
    io.to(String(roomId)).emit("system", {
      roomId: String(roomId),
      timestamp: new Date().toISOString(),
      ...payload, // e.g. { type: "pm_assigned_engineer", role: "PM", engineer: { id, firstName, lastName } }
    });
  } catch {}
};
