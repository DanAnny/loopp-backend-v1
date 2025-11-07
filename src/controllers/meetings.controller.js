// controllers/meetings.controller.js
import { createInstantMeeting } from "../services/zoom.service.js";

/**
 * POST /meetings/zoom
 * body: { projectId?: string, topic?: string, durationMinutes?: number }
 * Returns: { meeting_id, join_url, start_url, password, projectId }
 */
export async function createZoomMeetingController(req, res) {
  try {
    const { projectId, topic } = req.body;

    // Optional: enforce permissions (PM only) and project membership
    // Example (swap for your real guards):
    // if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    // if (!["PM", "SuperAdmin", "Admin"].includes(String(req.user.role))) {
    //   return res.status(403).json({ message: "Only PMs can create meetings" });
    // }
    // TODO: verify req.user is PM of projectId if sent

    const meeting = await createInstantMeeting({ topic });
    return res.json({ ...meeting, projectId: projectId || null });
  } catch (e) {
    console.error("createZoomMeetingController error:", e);
    return res.status(500).json({ message: e.message || "Failed to create Zoom meeting" });
  }
}
