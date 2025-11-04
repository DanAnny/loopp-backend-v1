// src/services/email.service.js
import nodemailer from "nodemailer";
import { config } from "../config/env.js";

/* ============================================================================
 * SMTP / Transport
 * ========================================================================== */

function normalizeFrom(v) {
  // Accept "Name <email@domain>" or just "email@domain"
  if (/<.+>/.test(String(v || ""))) return v;
  const email = String(v || "no-reply@localhost").trim();
  return `Loopp AI <${email}>`;
}

const smtpEnabled = !!config?.smtp?.enabled;
const smtpHost    = config?.smtp?.host || "smtp-relay.brevo.com";
const smtpPort    = Number(config?.smtp?.port || 587);
const smtpUser    = config?.smtp?.user;
const smtpPass    = config?.smtp?.pass;
const fromHeader  = normalizeFrom(config?.smtp?.mailFrom);

let transport = null;

if (smtpEnabled && smtpHost && smtpPort && smtpUser && smtpPass) {
  transport = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: String(smtpPort) === "465",   // 465 = TLS, 587 = STARTTLS
    requireTLS: String(smtpPort) !== "465",
    auth: { user: smtpUser, pass: smtpPass },
    tls: { minVersion: "TLSv1.2" },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
  });

  // Verify once on boot
  transport.verify()
    .then(() => {
      console.log("[mailer] ✅ transport ready (Brevo SMTP verified)");
    })
    .catch(err => {
      console.warn("[mailer] ❗ transport verify failed:", err?.message);
    });

  console.log("[boot] SMTP flags", {
    enabled: smtpEnabled,
    host: smtpHost,
    port: smtpPort,
    user: smtpUser ? "(set)" : "(missing)",
    from: fromHeader,
  });
} else {
  console.warn("[mailer] (disabled) Set SMTP_ENABLED=true and all SMTP_* envs to send email.");
}

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
 * Shared Template Utilities
 * ========================================================================== */

const BRAND_COLOR = "#111";          // heading color
const ACCENT      = "#0EA5E9";       // buttons/links
const MUTED       = "#6b7280";       // muted text
const BORDER      = "#e5e7eb";       // light border

function wrapHtml(inner, title = "Loopp") {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;background:#f7f7f8;padding:24px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:0 auto;background:#fff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden">
    <tr>
      <td style="padding:24px 24px 8px 24px;background:#fff">
        <div style="font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.6;color:#111">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
            <div style="width:10px;height:10px;border-radius:999px;background:${ACCENT}"></div>
            <span style="font-weight:600;color:${MUTED};letter-spacing:.08em;text-transform:uppercase">Loopp</span>
          </div>
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

function cta(href, label = "Open") {
  const url = String(href || "").trim();
  return url
    ? `<p style="margin:16px 0 0">
         <a href="${escapeHtml(url)}" target="_blank" rel="noopener" 
            style="display:inline-block;background:${ACCENT};color:#fff;text-decoration:none;
                   padding:10px 16px;border-radius:10px;font-weight:600">
           ${escapeHtml(label)}
         </a>
       </p>`
    : "";
}

function keyval(label, value) {
  return `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid ${BORDER};color:${MUTED};white-space:nowrap">${escapeHtml(label)}</td>
    <td style="padding:8px 12px;border-bottom:1px solid ${BORDER};color:#111">${escapeHtml(value ?? "—")}</td>
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
 * Link Targets (optional)
 * ========================================================================== */

const appUrl     = config?.appUrl || "";           // e.g., https://loopp.com
const chatUrl    = appUrl ? `${appUrl}/chat` : "/chat";
const adminUrlOf = (id) => (appUrl ? `${appUrl}/admin/projects/${id}` : `/admin/projects/${id}`);

/* ============================================================================
 * TEMPLATES: Subjects + HTML (full messages)
 * ========================================================================== */

/** CLIENT → "We received your request" */
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
      Thanks ${escapeHtml(name)}, we’ve got your request ✅
    </h1>
    <p style="margin:0 0 12px 0;color:${MUTED}">
      We’re assigning a Project Manager now. You’ll hear from us shortly in your chat room.
    </p>
    ${detailsTable(
      keyval("Title", title) +
      keyval("Target date", due) +
      keyval("Request ID", String(req?._id || "—"))
    )}
    ${cta(chatUrl, "Open Chat")}
    <p style="margin:16px 0 0;color:${MUTED}">
      If you didn’t make this request, please reply to this email.
    </p>
  `;
  return wrapHtml(inner, "We received your request");
}

/** SUPER ADMINS → "New request" */
function adminsNewRequestSubject(req) {
  const t = req?.projectTitle || "Untitled";
  const n = `${req?.firstName || ""} ${req?.lastName || ""}`.trim();
  return `New request: ${t}${n ? ` — ${n}` : ""}`;
}
function adminsNewRequestHtml(req) {
  const inner = `
    <h1 style="margin:0 0 8px 0;font-size:20px;color:${BRAND_COLOR}">New Project Request</h1>
    ${detailsTable(
      keyval("Client", `${req?.firstName || ""} ${req?.lastName || ""} (${req?.email || "n/a"})`) +
      keyval("Title", req?.projectTitle || "Untitled") +
      keyval("Target date", formatDate(req?.completionDate)) +
      keyval("Request ID", String(req?._id || "—"))
    )}
    ${cta(adminUrlOf(req?._id), "Open in Admin")}
  `;
  return wrapHtml(inner, "New request");
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
    </p>
    ${detailsTable(
      keyval("Client", `${req?.firstName || ""} ${req?.lastName || ""}`.trim()) +
      keyval("Email", req?.email || "n/a") +
      keyval("Target date", formatDate(req?.completionDate)) +
      keyval("Request ID", String(req?._id || "—"))
    )}
    ${cta(chatUrl, "Open Chat Inbox")}
    <p style="margin:16px 0 0;color:${MUTED}">
      Join the room to assist if you’re available.
    </p>
  `;
  return wrapHtml(inner, "New request available");
}

/** CLIENT → "Thank you / Project complete" */
function clientThankYouSubject() {
  return "Thanks! Your project is complete";
}
function clientThankYouHtml(req) {
  const t = req?.projectTitle || "your project";
  const inner = `
    <h1 style="margin:0 0 8px 0;font-size:22px;color:${BRAND_COLOR}">Project completed 🎉</h1>
    <p style="margin:0 0 12px 0;color:${MUTED}">
      Thanks for working with us. We’ve marked <strong>${escapeHtml(t)}</strong> as complete.
    </p>
    <p style="margin:0;color:${MUTED}">
      Your feedback helps us improve. You can reply to this email with any follow-ups,
      or reopen the chat if you need more work done.
    </p>
    ${cta(chatUrl, "Go to Chat")}
  `;
  return wrapHtml(inner, "Project completed");
}

/* ============================================================================
 * Public API (named exports)
 * ========================================================================== */

/**
 * Notify the client that their request was received.
 * @param {object} req ProjectRequest doc
 */
export async function emailClientNewRequest(req) {
  if (!req?.email) return { skipped: true, reason: "no client email" };
  return safeSend({
    to: req.email,
    subject: clientNewRequestSubject(req),
    html: clientNewRequestHtml(req),
  });
}

/**
 * Notify all SuperAdmins (array of users with emails).
 * @param {object} req ProjectRequest doc
 * @param {Array<{email:string,firstName?:string,lastName?:string}>} superAdmins
 */
export async function emailSuperAdminsNewRequest(req, superAdmins = []) {
  const toList = superAdmins.map(a => a?.email).filter(Boolean);
  if (!toList.length) return { skipped: true, reason: "no superadmin emails" };
  // Send as a single message (multiple "to") — these are internal recipients.
  return safeSend({
    to: toList,
    subject: adminsNewRequestSubject(req),
    html: adminsNewRequestHtml(req),
  });
}

/**
 * Optional broadcast to PMs when a new request arrives (use BCC to avoid reply-all).
 * @param {object} req ProjectRequest doc
 * @param {string[]} pmEmails
 */
export async function emailPMsBroadcastNewRequest(req, pmEmails = []) {
  const list = pmEmails.filter(Boolean);
  if (!list.length) return { skipped: true, reason: "no pm emails" };

  // To satisfy SMTP providers & avoid huge headers, chunk BCC in groups (e.g., 50).
  const CHUNK = 50;
  const results = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const to = chunk[0];           // one visible "to"
    const bcc = chunk.slice(1);    // remainder in bcc
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

/**
 * Thank-you email to the client after the project is completed.
 * @param {object} req ProjectRequest doc
 */
export async function emailClientThankYou(req) {
  if (!req?.email) return { skipped: true, reason: "no client email" };
  return safeSend({
    to: req.email,
    subject: clientThankYouSubject(req),
    html: clientThankYouHtml(req),
  });
}
