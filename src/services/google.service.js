import { google } from "googleapis";
import { config } from "../config/env.js";

const baseOAuth2Client = new google.auth.OAuth2(
  config.googleClientId || process.env.GOOGLE_CLIENT_ID,
  config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET,
  config.googleRedirectUri || process.env.GOOGLE_REDIRECT_URI
);

// ---- build the Google consent URL for the PM ----
export function getGoogleAuthUrl(userId) {
  const scopes = ["https://www.googleapis.com/auth/calendar.events"];

  return baseOAuth2Client.generateAuthUrl({
    access_type: "offline", // needed for refresh_token
    prompt: "consent",      // forces Google to return refresh_token
    scope: scopes,
    // carry Loopp user id through the OAuth roundtrip
    state: userId ? String(userId) : undefined,
  });
}

export async function exchangeCodeForTokens(code) {
  const { tokens } = await baseOAuth2Client.getToken(code);
  return tokens;
}

export function getGoogleClientWithRefreshToken(refreshToken) {
  if (!refreshToken) {
    const err = new Error("Missing Google refresh token");
    err.code = "MISSING_GOOGLE_REFRESH_TOKEN";
    throw err;
  }

  // NOTE: if you ever run into concurrency issues, create a *new*
  // OAuth2 client instance here instead of reusing baseOAuth2Client.
  const client = baseOAuth2Client;
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

/**
 * Create a Google Calendar event with a Meet link.
 *
 * @param {Object} params
 * @param {Object} params.user   - Loopp user document (must include googleRefreshToken)
 * @param {Object} params.project - Project document (for title/description)
 * @param {string} [params.startISO] - ISO string for event start (from PM modal)
 * @param {string} [params.endISO]   - ISO string for event end (from PM modal)
 */
export async function createGoogleMeetEvent({ user, project, startISO, endISO }) {
  const refreshToken = user.googleRefreshToken; // make sure this field exists on User
  if (!refreshToken) {
    const err = new Error("Google account not connected");
    err.code = "GOOGLE_NOT_CONNECTED";
    throw err;
  }

  const auth = getGoogleClientWithRefreshToken(refreshToken);
  const calendar = google.calendar({ version: "v3", auth });

  // --- Use times from PM modal if provided, otherwise fallback ---

  const now = Date.now();

  let start = startISO ? new Date(startISO) : new Date(now + 5 * 60 * 1000);
  let end;

  if (endISO) {
    end = new Date(endISO);
  } else {
    // default: 60 minutes after start if end not explicitly provided
    end = new Date(start.getTime() + 60 * 60 * 1000);
  }

  // If dates are invalid, fall back to “5 minutes from now” for 1 hour
  if (isNaN(start.getTime())) {
    start = new Date(now + 5 * 60 * 1000);
  }
  if (isNaN(end.getTime())) {
    end = new Date(start.getTime() + 60 * 60 * 1000);
  }

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const requestId =
    "loopp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

  const res = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    requestBody: {
      summary: project?.projectTitle || "Loopp project sync",
      description: `Project: ${project?.projectTitle || project?._id || "Loopp project"}`,
      start: {
        dateTime: startIso,
        // timeZone: optional – if you want explicit TZ, set it here
      },
      end: {
        dateTime: endIso,
        // timeZone: optional – same as above
      },
      conferenceData: {
        createRequest: {
          requestId,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });

  const evt = res.data || {};
  const meetUrl =
    evt.hangoutLink ||
    evt?.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;

  if (!meetUrl) {
    const err = new Error("Google returned event without a Meet link");
    err.code = "NO_MEET_LINK";
    throw err;
  }

  return {
    meetUrl,
    eventId: evt.id,
    start: startIso,
    end: endIso,
  };
}
