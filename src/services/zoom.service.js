// services/zoom.service.js
// Node >=18 has global fetch; if you're on Node 16, install node-fetch and import it.

let tokenCache = {
  accessToken: null,
  // store epoch ms when the token expires; we refresh a little early
  expiresAt: 0,
};

async function getZoomAccessToken() {
  const now = Date.now();
  if (tokenCache.accessToken && now < tokenCache.expiresAt - 30_000) {
    return tokenCache.accessToken;
  }

  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId  = process.env.ZOOM_CLIENT_ID;
  const clientSec = process.env.ZOOM_CLIENT_SECRET;
  if (!accountId || !clientId || !clientSec) {
    throw new Error("Missing Zoom env vars (ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET)");
  }

  const res = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSec}`).toString("base64"),
    },
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Zoom token error: ${res.status} ${t}`);
  }

  const json = await res.json(); // { access_token, token_type, expires_in }
  tokenCache.accessToken = json.access_token;
  tokenCache.expiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return tokenCache.accessToken;
}

/**
 * Create an instant meeting on Zoom (type=1).
 * @param {Object} opts
 * @param {string} opts.topic
 * @returns {Promise<{meeting_id: number, join_url: string, start_url: string, password?: string}>}
 */
export async function createInstantMeeting({ topic = "Project Sync" } = {}) {
  const accessToken = await getZoomAccessToken();

  const body = {
    topic,
    type: 1, // instant meeting
    settings: {
      join_before_host: true,
      waiting_room: false,
      approval_type: 0,
      mute_upon_entry: true,
      participant_video: false,
      host_video: false,
    },
  };

  const r = await fetch("https://api.zoom.us/v2/users/me/meetings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Zoom create error: ${r.status} ${t}`);
  }

  const json = await r.json(); // { id, join_url, start_url, password, ... }
  return {
    meeting_id: json.id,
    join_url: json.join_url,
    start_url: json.start_url,
    password: json.password,
  };
}
