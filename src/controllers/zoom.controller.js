// backend/src/controllers/zoom.controller.js
import fetch from "node-fetch";

const {
  ZOOM_ACCOUNT_ID,
  ZOOM_CLIENT_ID,
  ZOOM_CLIENT_SECRET,
  ZOOM_HOST_EMAIL,
} = process.env;

function assertZoomEnv() {
  const missing = [];
  if (!ZOOM_ACCOUNT_ID) missing.push("ZOOM_ACCOUNT_ID");
  if (!ZOOM_CLIENT_ID) missing.push("ZOOM_CLIENT_ID");
  if (!ZOOM_CLIENT_SECRET) missing.push("ZOOM_CLIENT_SECRET");
  if (missing.length) {
    throw new Error(`Missing Zoom env: ${missing.join(", ")}`);
  }
}

async function getZoomAccessToken() {
  assertZoomEnv();

  const auth = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString("base64");
  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(
    ZOOM_ACCOUNT_ID
  )}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Zoom token error ${resp.status}: ${text}`);
  }
  return resp.json(); // { access_token, token_type, expires_in, scope }
}

// POST /api/integrations/zoom/meetings
// body: { topic?: string, duration?: number, hostEmail?: string }
export async function createZoomMeeting(req, res) {
  try {
    const { topic = "Project Sync", duration = 30, hostEmail } = req.body;

    const { access_token } = await getZoomAccessToken();

    // Host selection: use provided hostEmail (PM’s zoom email), else env, else "me"
    const userId = hostEmail || ZOOM_HOST_EMAIL || "me";

    const resp = await fetch(
      `https://api.zoom.us/v2/users/${encodeURIComponent(userId)}/meetings`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: 1,  // 1 = Instant meeting
          topic,
          duration, // ignored for instant; harmless to include
          settings: {
            join_before_host: true, // client can enter before PM clicks start; set false if you prefer
            waiting_room: false,
          },
        }),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Zoom API error ${resp.status}: ${text}`);
    }

    const data = await resp.json(); // { id, join_url, start_url, ... }
    res.json({
      meetingId: data.id,
      joinUrl: data.join_url,
      startUrl: data.start_url,
    });
  } catch (err) {
    console.error("Zoom error:", err);
    res.status(500).json({ message: err.message || "Zoom error" });
  }
}
