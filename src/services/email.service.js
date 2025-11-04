// src/services/email.service.js
import nodemailer from "nodemailer";
import { config } from "../config/env.js";

/* ============================================================================
 * SMTP / Transport (with 587→465 fallback + robust timeouts)
 * ========================================================================== */

function normalizeFrom(v) {
  if (/<.+>/.test(String(v || ""))) return v;         // already "Name <mail@x>"
  const email = String(v || "no-reply@localhost").trim();
  return `Loopp AI <${email}>`;
}

const smtpEnabled = !!config?.smtp?.enabled;
const smtpHost    = config?.smtp?.host || "smtp-relay.brevo.com";
const forcedPort  = config?.smtp?.port ? Number(config.smtp.port) : null; // allow override
const smtpUser    = config?.smtp?.user;
const smtpPass    = config?.smtp?.pass;
const fromHeader  = normalizeFrom(config?.smtp?.mailFrom);

const BASE_OPTS = {
  host: smtpHost,
  auth: { user: smtpUser, pass: smtpPass },
  family: 4,
  connectionTimeout: 20000,
  greetingTimeout:   15000,
  socketTimeout:     30000,
  tls: { minVersion: "TLSv1.2" },
  pool: true,
  maxConnections: 5,
  maxMessages: 100,
};

let transport = null;

async function makeTransportTry(port, secure) {
  const t = nodemailer.createTransport({
    ...BASE_OPTS,
    port,
    secure,                 // 587 => false (STARTTLS), 465 => true (implicit TLS)
    requireTLS: !secure,
  });
  await t.verify();
  return t;
}

async function buildTransport() {
  if (!smtpEnabled || !smtpHost || !smtpUser || !smtpPass) {
    console.warn("[mailer] (disabled) Set SMTP_ENABLED=true and SMTP_* envs to send email.");
    return null;
  }

  if (forcedPort) {
    const secure = String(forcedPort) === "465";
    try {
      const t = await makeTransportTry(forcedPort, secure);
      console.log(`[mailer] ✅ SMTP verified on ${forcedPort} (${secure ? "implicit TLS" : "STARTTLS"})`);
      return t;
    } catch (e) {
      console.warn(`[mailer] ❗ verify failed on ${forcedPort}:`, e?.message);
      return null;
    }
  }

  try {
    const t587 = await makeTransportTry(587, false);
    console.log("[mailer] ✅ SMTP verified on 587 (STARTTLS)");
    return t587;
  } catch (e587) {
    console.warn("[mailer] 587 verify failed:", e587?.message);
    try {
      const t465 = await makeTransportTry(465, true);
      console.log("[mailer] ✅ SMTP verified on 465 (implicit TLS)");
      return t465;
    } catch (e465) {
      console.error("[mailer] 465 verify failed:", e465?.message);
      return null;
    }
  }
}

// build once on import
(async () => {
  transport = await buildTransport();
  console.log("[boot] SMTP flags", {
    enabled: smtpEnabled,
    host: smtpHost,
    port: transport ? (transport.options?.port || "(unknown)") : "(none)",
    user: smtpUser ? "(set)" : "(missing)",
    from: fromHeader,
  });
})();

/**
 * Safely send mail; logs every attempt.
 * @param {{to:string|string[], bcc?:string|string[], subject:string, html?:string, text?:string}} param0
 * @returns {Promise<{queued:boolean, messageId?:string, disabled?:boolean, error?:string}>}
 */
async function safeSend({ to, bcc, subject, html, text }) {
  if (!transport) {
    console.log("[mailer] (disabled) would send →", { to, bcc, subject });
    return { queued: false, disabled: true };
  }

  const payload = {
    from: fromHeader,
    to,
    bcc,
    subject,
    text: text || stripHtml(html || ""),
    html: html || (text ? `<pre style="font-family:monospace">${escapeHtml(text)}</pre>` : "<p>(no content)</p>"),
  };

  try {
    const info = await transport.sendMail(payload);
    console.log("[mailer] sent:", { to, bcc, subject, messageId: info.messageId });
    return { queued: true, messageId: info.messageId };
  } catch (e) {
    console.error("[mailer] send failed:", e?.message);
    return { queued: false, error: e?.message || "send failed" };
  }
}

/* ============================================================================
 * Black & White Template Utilities (no buttons)
 * ========================================================================== */

const BRAND_COLOR = "#111";
const TEXT       = "#111";
const MUTED      = "#444";
const BORDER     = "#e5e7eb";
const BG         = "#f8f8f8";

/**
 * Wraps email body with a B/W shell. Optional header image.
 * @param {string} inner
 * @param {string} title
 * @param {string|null} headerImgUrl
 */
function wrapHtmlBW(inner, title = "Loopp", headerImgUrl = null) {
  const headerImg = headerImgUrl
    ? `<div style="text-align:center;margin:0 0 16px 0">
         <img src="${escapeHtml(headerImgUrl)}" alt="Header" style="max-width:180px;height:auto;display:inline-block" />
       </div>`
    : `<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
         <div style="width:10px;height:10px;border-radius:999px;background:#000"></div>
         <span style="font-weight:600;color:${MUTED};letter-spacing:.08em;text-transform:uppercase">Loopp</span>
       </div>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;background:${BG};padding:24px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;background:#fff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden">
    <tr>
      <td style="padding:24px;background:#fff">
        <div style="font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.6;color:${TEXT}">
          ${headerImg}
          ${inner}
          <hr style="border:none;border-top:1px solid ${BORDER};margin:24px 0">
          <p style="margin:0;color:${MUTED};font-size:12px">
            You’re receiving this because you have a Loopp account or interacted with our services.
          </p>
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function keyval(label, value) {
  return `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid ${BORDER};color:${MUTED};white-space:nowrap">${escapeHtml(label)}</td>
    <td style="padding:8px 12px;border-bottom:1px solid ${BORDER};color:${TEXT}">${escapeHtml(value ?? "—")}</td>
  </tr>`;
}

function detailsTable(rowsHtml) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"
           style="border:1px solid ${BORDER};border-radius:10px;overflow:hidden;margin:12px 0 0 0">
    <tbody>${rowsHtml}</tbody>
  </table>`;
}

function formatDate(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (Number.isNaN(+dt)) return "—";
    return dt.toLocaleString("en-GB", { year:"numeric", month:"short", day:"2-digit" });
  } catch {
    return "—";
  }
}

function stripHtml(s = "") {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function escapeHtml(s = "") {
  return s.replace(/[&<>'"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;" }[c]));
}

/* ============================================================================
 * Link Targets (only plain links if needed — no buttons)
 * ========================================================================== */

const appUrl     = config?.appUrl || "";
const chatUrl    = appUrl ? `${appUrl}/chat` : "/chat";
const adminUrlOf = (id) => (appUrl ? `${appUrl}/admin/projects/${id}` : `/admin/projects/${id}`);

// Headers
const STAFF_LOGO = "https://angelmap.foundryradar.com/wp-content/uploads/2025/03/cropped-cropped-4.png";
const CLIENT_GIF = "https://angelmap.foundryradar.com/wp-content/uploads/2025/11/Loop_gif.gif";

/* ============================================================================
 * TEMPLATES
 * ========================================================================== */

/** CLIENT → New request acknowledgement */
function clientNewRequestSubject(req) {
  const t = req?.projectTitle || "New project";
  return `We received your request: ${t}`;
}
function clientNewRequestHtml(req) {
  const title = req?.projectTitle || "New project";
  const name  = `${req?.firstName || ""} ${req?.lastName || ""}`.trim() || "there";
  const due   = formatDate(req?.completionDate);

  const inner = `
    <h1 style="margin:0 0 8px 0;font-size:22px;line-height:1.35;color:${BRAND_COLOR}">
      Thank you for choosing Loopp, ${escapeHtml(name)}.
    </h1>
    <p style="margin:0 0 8px 0;color:${MUTED}">
      We’ve received your project request and we’re assigning the best Project Manager for you now.
      Sit back—your PM will join this chat shortly to guide everything step by step so you feel in control at every point.
    </p>
    ${detailsTable(
      keyval("Title", title) +
      keyval("Target date", due) +
      keyval("Request ID", String(req?._id || "—"))
    )}
    <p style="margin:12px 0 0;color:${MUTED}">
      While you wait, you can explore more at 
      <a href="https://angelmap.foundryradar.com/" target="_blank" rel="noopener">https://angelmap.foundryradar.com/</a>.
    </p>
    <p style="margin:12px 0 0;color:${MUTED}">
      If you didn’t make this request, please reply to this email.
    </p>
  `;
  return wrapHtmlBW(inner, "We received your request", CLIENT_GIF);
}

/** SUPER ADMINS → New request (no PM yet) */
function adminsNewRequestSubject(req) {
  const t = req?.projectTitle || "Untitled";
  const n = `${req?.firstName || ""} ${req?.lastName || ""}`.trim();
  return `New request: ${t}${n ? ` — ${n}` : ""}`;
}
function adminsNewRequestHtml_NoPM(req) {
  const inner = `
    <h1 style="margin:0 0 8px 0;font-size:20px;color:${BRAND_COLOR}">New Project Request</h1>
    <p style="margin:0 0 8px 0;color:${MUTED}">
      A new project request has been submitted. No PM has been assigned yet.
      Please ensure a Project Manager reaches out to the client immediately.
    </p>
    ${detailsTable(
      keyval("Client", `${req?.firstName || ""} ${req?.lastName || ""} (${req?.email || "n/a"})`) +
      keyval("Title", req?.projectTitle || "Untitled") +
      keyval("Target date", formatDate(req?.completionDate)) +
      keyval("Status", "Pending — PM not assigned") +
      keyval("Admin", adminUrlOf(req?._id))
    )}
  `;
  return wrapHtmlBW(inner, "New request", STAFF_LOGO);
}

/** SUPER ADMINS → PM assigned update */
function adminsAssignedSubject(req, pmName) {
  const t = req?.projectTitle || "Project";
  return `PM assigned: ${t} — ${pmName || "PM"}`;
}
function adminsAssignedHtml(req, pmName) {
  const inner = `
    <h1 style="margin:0 0 8px 0;font-size:20px;color:${BRAND_COLOR}">PM Assigned</h1>
    <p style="margin:0 0 8px 0;color:${MUTED}">
      A Project Manager has been assigned to this project.
    </p>
    ${detailsTable(
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Client", `${req?.firstName || ""} ${req?.lastName || ""} (${req?.email || "n/a"})`) +
      keyval("PM", pmName || "PM") +
      keyval("Status", "In progress — PM assigned") +
      keyval("Admin", adminUrlOf(req?._id))
    )}
  `;
  return wrapHtmlBW(inner, "PM assigned", STAFF_LOGO);
}

/** PMs → Broadcast "New client request available" (BCC) */
function pmsBroadcastSubject(req) {
  return `New client request available: ${req?.projectTitle || "Project"}`;
}
function pmsBroadcastHtml(req) {
  const inner = `
    <h1 style="margin:0 0 8px 0;font-size:20px;color:${BRAND_COLOR}">New Request Available</h1>
    <p style="margin:0 0 12px 0;color:${MUTED}">
      ${escapeHtml(`${req?.firstName || ""} ${req?.lastName || ""}`.trim())} submitted
      “${escapeHtml(req?.projectTitle || "Project")}”.
      Please check the chat inbox and attend to the client immediately.
    </p>
    ${detailsTable(
      keyval("Client", `${req?.firstName || ""} ${req?.lastName || ""}`.trim()) +
      keyval("Email", req?.email || "n/a") +
      keyval("Target date", formatDate(req?.completionDate)) +
      keyval("Request ID", String(req?._id || "—"))
    )}
    <p style="margin:12px 0 0;color:${MUTED}">
      Chat: ${escapeHtml(chatUrl)}
    </p>
  `;
  return wrapHtmlBW(inner, "New request available", STAFF_LOGO);
}

/** PMs → Inform all PMs that a PM has now been assigned */
function pmsAssignedSubject(req, pmName) {
  return `PM assigned: ${req?.projectTitle || "Project"} — ${pmName || "PM"}`;
}
function pmsAssignedHtml(req, pmName) {
  const inner = `
    <h1 style="margin:0 0 8px 0;font-size:20px;color:${BRAND_COLOR}">PM Assigned</h1>
    <p style="margin:0 0 12px 0;color:${MUTED}">
      A PM has been assigned for this project (${escapeHtml(pmName || "PM")}). You can continue collaborating for progress and support as needed.
    </p>
    ${detailsTable(
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Client", `${req?.firstName || ""} ${req?.lastName || ""}`.trim()) +
      keyval("Status", "In progress — PM assigned") +
      keyval("Request ID", String(req?._id || "—"))
    )}
    <p style="margin:12px 0 0;color:${MUTED}">
      Chat: ${escapeHtml(chatUrl)}
    </p>
  `;
  return wrapHtmlBW(inner, "PM assigned", STAFF_LOGO);
}

/** CLIENT → Thank-you on complete */
function clientThankYouSubject() {
  return "Thanks! Your project is complete";
}
function clientThankYouHtml(req) {
  const t = req?.projectTitle || "your project";
  const inner = `
    <h1 style="margin:0 0 8px 0;font-size:22px;color:${BRAND_COLOR}">Project completed 🎉</h1>
    <p style="margin:0 0 12px 0;color:${MUTED}">
      Thanks for working with us. We’ve marked <strong>${escapeHtml(t)}</strong> as complete.
      Your feedback helps us improve — simply reply to this email with any thoughts.
    </p>
    <p style="margin:0;color:${MUTED}">
      You can reopen the chat if you need more work done at any time.
    </p>
  `;
  return wrapHtmlBW(inner, "Project completed", CLIENT_GIF);
}

/* ============================================================================
 * Public API (named exports)
 * ========================================================================== */

export async function emailClientNewRequest(req) {
  if (!req?.email) return { skipped: true, reason: "no client email" };
  return safeSend({
    to: req.email,
    subject: clientNewRequestSubject(req),
    html: clientNewRequestHtml(req),
  });
}

export async function emailSuperAdminsNewRequest_NoPM(req, superAdmins = []) {
  const toList = superAdmins.map(a => a?.email).filter(Boolean);
  if (!toList.length) return { skipped: true, reason: "no superadmin emails" };
  return safeSend({
    to: toList,
    subject: adminsNewRequestSubject(req),
    html: adminsNewRequestHtml_NoPM(req),
  });
}

export async function emailSuperAdminsAssigned(req, pmName, superAdmins = []) {
  const toList = superAdmins.map(a => a?.email).filter(Boolean);
  if (!toList.length) return { skipped: true, reason: "no superadmin emails" };
  return safeSend({
    to: toList,
    subject: adminsAssignedSubject(req, pmName),
    html: adminsAssignedHtml(req, pmName),
  });
}

export async function emailPMsBroadcastNewRequest(req, pmEmails = []) {
  const list = pmEmails.filter(Boolean);
  if (!list.length) return { skipped: true, reason: "no pm emails" };

  // Chunk BCC in groups of 50 to avoid oversized headers
  const CHUNK = 50;
  const results = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const to = chunk[0];
    const bcc = chunk.slice(1);
    // eslint-disable-next-line no-await-in-loop
    const r = await safeSend({
      to,
      bcc,
      subject: pmsBroadcastSubject(req),
      html: pmsBroadcastHtml(req),
    });
    results.push(r);
  }
  return results;
}

export async function emailPMsOnPmAssigned(req, pmName, pmEmails = []) {
  const list = pmEmails.filter(Boolean);
  if (!list.length) return { skipped: true, reason: "no pm emails" };

  const CHUNK = 50;
  const results = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const to = chunk[0];
    const bcc = chunk.slice(1);
    // eslint-disable-next-line no-await-in-loop
    const r = await safeSend({
      to,
      bcc,
      subject: pmsAssignedSubject(req, pmName),
      html: pmsAssignedHtml(req, pmName),
    });
    results.push(r);
  }
  return results;
}

export async function emailClientThankYou(req) {
  if (!req?.email) return { skipped: true, reason: "no client email" };
  return safeSend({
    to: req.email,
    subject: clientThankYouSubject(req),
    html: clientThankYouHtml(req),
  });
}
