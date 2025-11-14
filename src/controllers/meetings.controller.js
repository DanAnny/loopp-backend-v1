// backend/src/controllers/meetings.controller.js
import { User } from "../models/User.js";
import { ProjectRequest } from "../models/ProjectRequest.js";
import { createGoogleMeetEvent } from "../services/google.service.js";

export async function createGoogleMeetHandler(req, res) {
  try {
    // 🔧 make sure we get the actual id
    const userId = req.user?.id || req.user?._id;

    if (!userId) {
      return res
        .status(401)
        .json({ success: false, message: "No authenticated user id found" });
    }

    const pm = await User.findById(userId);
    if (!pm) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    const { projectId, startISO, endISO } = req.body;

    const project = projectId
      ? await ProjectRequest.findById(projectId)
      : null;

    // ✅ pass PM-selected times through to the Google helper
    const { meetUrl, eventId, start, end } = await createGoogleMeetEvent({
      user: pm,
      project,
      startISO,
      endISO,
    });

    if (project) {
      project.lastMeet = {
        url: meetUrl,
        eventId,
        start,
        end,
        createdBy: pm._id,
      };
      await project.save({ validateBeforeSave: false });
    }

    return res.json({
      success: true,
      meetUrl,
      joinUrl: meetUrl,
      eventId,
      start,
      end,
    });
  } catch (err) {
    console.error("createGoogleMeetHandler error:", err?.response?.data || err);

    if (
      err.code === "GOOGLE_NOT_CONNECTED" ||
      err.code === "MISSING_GOOGLE_REFRESH_TOKEN"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Please connect your Google account in Loopp before creating a Meet link.",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to create Google Meet link. Please try again.",
      detail: err.message,
    });
  }
}
