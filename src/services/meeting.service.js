import { google } from "googleapis";
import { getAuthorizedClientForUser } from "./google.service.js";

export async function createGoogleMeetForProject({ userId, projectTitle }) {
  const auth = await getAuthorizedClientForUser(userId);
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const end = new Date(now.getTime() + 30 * 60 * 1000); // 30 mins

  const requestId = `meet-${userId}-${Date.now()}`;

  const res = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    requestBody: {
      summary: projectTitle || "Loopp project meeting",
      start: { dateTime: now.toISOString() },
      end: { dateTime: end.toISOString() },
      conferenceData: {
        createRequest: {
          requestId,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });

  const event = res.data;
  const conference = event.conferenceData;
  const entry =
    conference?.entryPoints?.find((e) => e.entryPointType === "video") || null;

  const url =
    entry?.uri ||
    (conference?.conferenceId
      ? `https://meet.google.com/${conference.conferenceId}`
      : null);

  if (!url) throw new Error("NO_MEET_URL");

  return { url, eventId: event.id };
}
