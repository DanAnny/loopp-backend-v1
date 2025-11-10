// src/services/email.service.js
import nodemailer from "nodemailer";
import { config } from "../config/env.js";

/* ============================================================================
 * SMTP / Transport (with 587→465 fallback + robust timeouts)
 * ========================================================================== */

function normalizeFrom(v) {
  if (/<.+>/.test(String(v || ""))) return v; // already "Name <mail@x>"
  const email = String(v || "no-reply@localhost").trim();
  return `Loopp AI <${email}>`;
}

const smtpEnabled = !!config?.smtp?.enabled;
const smtpHost    = config?.smtp?.host || "smtp-relay.brevo.com";
const forcedPort  = config?.smtp?.port ? Number(config.smtp.port) : null;
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
 * Dark Theme Template Utilities (buttons + sections)
 * ========================================================================== */

const BORDER = "#2a2a2a";
const BG_PAGE = "#0b0b0b";
const CARD_BG = "#111";
const TEXT    = "#f5f5f5";
const MUTED   = "#d1d5db";

/** Black pill button (inline-safe) */
function button(label, href) {
  const safeHref = escapeHtml(href || "#");
  const safeLabel = escapeHtml(label || "Open");
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:14px 0 0 0">
      <tr>
        <td align="left" style="border-radius:999px;background:#000">
          <a href="${safeHref}" target="_blank" rel="noopener"
             style="display:inline-block;padding:12px 18px;border-radius:999px;background:#000;color:#fff;
                    text-decoration:none;font-weight:700;font-family:Inter,Arial,sans-serif">
            ${safeLabel}
          </a>
        </td>
      </tr>
    </table>
  `;
}

/** 2-line section title + paragraph + CTA button (like your screenshot) */
function ctaBlock(heading, text, ctaLabel, ctaHref) {
  return `
    <h3 style="margin:20px 0 6px 0;font-size:16px;line-height:1.35;color:${TEXT}">${escapeHtml(heading)}</h3>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      ${escapeHtml(text)}
    </p>
    ${button(ctaLabel, ctaHref)}
  `;
}

/**
 * Wrap body with dark card & optional header image.
 */
function wrapHtml(inner, title = "Loopp", headerImgUrl = null) {
  let headerImg = "";
  if (headerImgUrl) {
    const isClientGif = /Loop_gif\.gif$/i.test(headerImgUrl);
    headerImg = isClientGif
      ? `<div style="text-align:center;margin:0 0 16px 0">
           <img src="${escapeHtml(headerImgUrl)}" alt="Loopp" style="width:100%;max-width:100%;height:auto;border-radius:12px;display:block" />
         </div>`
      : `<div style="text-align:left;margin:0 0 16px 0">
           <img src="${escapeHtml(headerImgUrl)}" alt="Loopp" style="max-width:180px;height:auto;display:inline-block;border-radius:10px" />
         </div>`;
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;background:${BG_PAGE};padding:24px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;margin:0 auto;background:${CARD_BG};border:1px solid ${BORDER};border-radius:14px;overflow:hidden">
    <tr>
      <td style="padding:24px;background:${CARD_BG}">
        <div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.8;color:${TEXT}">
          ${headerImg || ""}
          ${inner}
          <hr style="border:none;border-top:1px solid ${BORDER};margin:24px 0">
          <p style="margin:0;color:#a3a3a3;font-size:12px">
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
  const show = value != null && String(value).trim() !== "";
  if (!show) return "";
  return `<tr>
    <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};color:#bfbfbf;white-space:nowrap">${escapeHtml(label)}</td>
    <td style="padding:10px 12px;border-bottom:1px solid ${BORDER};color:${TEXT}">${escapeHtml(value)}</td>
  </tr>`;
}

function detailsTable(rowsHtml) {
  if (!rowsHtml || !rowsHtml.trim()) return "";
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"
           style="border:1px solid ${BORDER};border-radius:12px;overflow:hidden;margin:16px 0 0 0">
    <tbody>${rowsHtml}</tbody>
  </table>`;
}

function stripHtml(s = "") {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function escapeHtml(s = "") {
  return s.replace(/[&<>'"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;" }[c]));
}

/* ============================================================================
 * Links & Headers
 * ========================================================================== */

const appUrl       = config?.appUrl || "";
const chatUrl      = appUrl ? `${appUrl}/chat` : "/chat";
const HIRE_URL     = "https://loopp.com/hire-an-engineer/";
const PARTNER_URL  = "https://loopp.com/become-a-partner/";

const STAFF_LOGO = "https://angelmap.foundryradar.com/wp-content/uploads/2025/03/cropped-cropped-4.png";
const CLIENT_GIF = "https://angelmap.foundryradar.com/wp-content/uploads/2025/11/Loop_gif.gif";

/* ============================================================================
 * EMAIL TEMPLATES
 * ========================================================================== */

/** CLIENT → New request acknowledgement */
function clientNewRequestSubject(req) {
  const t = req?.projectTitle || "New project";
  return `We received your request: ${t}`;
}
function clientNewRequestHtml(req, pmName, engineerName) {
  const title = req?.projectTitle || "your project";
  const name  = `${req?.firstName || ""} ${req?.lastName || ""}`.trim() || "there";

  const inner = `
    <h1 style="margin:8px 0 10px 0;font-size:28px;line-height:1.25;color:${TEXT};font-weight:800">
      Hire Top-Vetted AI Engineers
    </h1>
    ${button("Get started with Loopp", chatUrl)}

    <p style="margin:18px 0 0;color:${TEXT};font-weight:700">Hey ${escapeHtml(name)},</p>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      Thanks for sharing your project with us! We’ve got your details and we’re already thinking about how to make it happen.
    </p>

    <p style="margin:14px 0 6px 0;color:${TEXT};font-weight:700">Here’s what we’re seeing:</p>
    ${detailsTable(
      keyval("Project", title) +
      keyval("Project Manager", pmName || "Assigning now") +
      keyval("Engineer", engineerName || "Pending")
    )}

    <p style="margin:16px 0 0;color:${MUTED}">
      Next up: your Project Manager will reach out in the chat to confirm scope, align on milestones, and set the first deliverable.
      If there’s anything you want to tweak before then, just reply to this email.
    </p>

    ${ctaBlock(
      "Hire Top-Vetted AI Engineers",
      "Ship outcomes, not resumes. Our engineers plug into your stack and start delivering—ML, data, and automation without the hiring lag.",
      "Hire an engineer now",
      HIRE_URL
    )}

    ${ctaBlock(
      "Become a Partner",
      "Co-sell and co-build AI solutions with Loopp. Tap our playbooks, vetted talent, and buyer network to ship faster—together.",
      "Become a partner now",
      PARTNER_URL
    )}
  `;
  return wrapHtml(inner, "We received your request", CLIENT_GIF);
}

/** SUPER ADMINS → New request (no PM yet) */
function adminsNewRequestSubject(req) {
  const t = req?.projectTitle || "Untitled";
  const n = `${req?.firstName || ""} ${req?.lastName || ""}`.trim();
  return `New request: ${t}${n ? ` — ${n}` : ""}`;
}
function adminsNewRequestHtml_NoPM(req, pmName, engineerName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:22px;color:${TEXT}">New Project Request</h1>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      No PM assigned yet — please ensure a PM reaches out to the client immediately and confirms ownership.
    </p>
    ${detailsTable(
      keyval("Client", `${(req?.firstName || "")} ${(req?.lastName || "")} (${req?.email || "n/a"})`) +
      keyval("Project", req?.projectTitle || "Untitled") +
      keyval("Project Manager", pmName || "Unassigned") +
      keyval("Engineer", engineerName || "Pending")
    )}
  `;
  return wrapHtml(inner, "New request", STAFF_LOGO);
}

/** SUPER ADMINS → PM assigned update */
function adminsAssignedSubject(req, pmName) {
  const t = req?.projectTitle || "Project";
  return `PM assigned: ${t} — ${pmName || "PM"}`;
}
function adminsAssignedHtml(req, pmName, engineerName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:22px;color:${TEXT}">PM Assigned</h1>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      A Project Manager has been assigned. Track onboarding and ensure the first milestone is set in chat.
    </p>
    ${detailsTable(
      keyval("Client", `${(req?.firstName || "")} ${(req?.lastName || "")} (${req?.email || "n/a"})`) +
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Project Manager", pmName || "PM") +
      keyval("Engineer", engineerName || "Pending")
    )}
  `;
  return wrapHtml(inner, "PM assigned", STAFF_LOGO);
}

/** PMs → Broadcast "New client request available" (BCC) */
function pmsBroadcastSubject(req) {
  return `New client request: ${req?.projectTitle || "Project"}`;
}
function pmsBroadcastHtml(req, pmName, engineerName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:22px;color:${TEXT}">New Request Available</h1>
    <p style="margin:0 0 12px 0;color:${MUTED}">
      <strong>Please log in and take ownership immediately</strong> — a project request is pending ownership.
    </p>
    ${detailsTable(
      keyval("Client", `${(req?.firstName || "")} ${(req?.lastName || "")}`.trim()) +
      keyval("Email", req?.email || "n/a") +
      keyval("Project Manager", pmName || "Not assigned yet") +
      keyval("Engineer", engineerName || "Pending")
    )}
    ${button("Open Chat", chatUrl)}
  `;
  return wrapHtml(inner, "New request available", STAFF_LOGO);
}

/** PMs → Inform all PMs that a PM has now been assigned */
function pmsAssignedSubject(req, pmName) {
  return `PM assigned: ${req?.projectTitle || "Project"} — ${pmName || "PM"}`;
}
function pmsAssignedHtml(req, pmName, engineerName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:22px;color:${TEXT}">PM Assigned</h1>
    <p style="margin:0 0 12px 0;color:${MUTED}">
      PM is confirmed. Align with the team on scope, milestones, and communication cadence in the chat.
    </p>
    ${detailsTable(
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Client", `${(req?.firstName || "")} ${(req?.lastName || "")}`.trim()) +
      keyval("Project Manager", pmName || "PM") +
      keyval("Engineer", engineerName || "Pending")
    )}
    ${button("Open Chat", chatUrl)}
  `;
  return wrapHtml(inner, "PM assigned", STAFF_LOGO);
}

/** CLIENT → Thank-you on complete */
function clientThankYouSubject() {
  return "Thanks! Your project is complete";
}
function clientThankYouHtml(req, pmName, engineerName) {
  const t = req?.projectTitle || "your project";
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:26px;color:${TEXT}">Project completed 🎉</h1>
    <p style="margin:0 0 12px 0;color:${MUTED}">
      We’ve marked <strong>${escapeHtml(t)}</strong> as complete. Thank you for working with Loopp.
      If you’d like to adjust or extend anything, just reply or open your chat.
    </p>
    ${detailsTable(
      keyval("Project Manager", pmName || "PM") +
      keyval("Engineer", engineerName || "Engineer")
    )}
    ${button("Open Chat", chatUrl)}

    ${ctaBlock(
      "Hire Top-Vetted AI Engineers",
      "Have another idea? Our engineers can plug in and start delivering fast.",
      "Hire an engineer now",
      HIRE_URL
    )}
  `;
  return wrapHtml(inner, "Project completed", CLIENT_GIF);
}

/* ============================================================================
 * Engineer Accepted — client / PMs / super-admins
 * ========================================================================== */

function clientEngineerAcceptedSubject(req, engineerName) {
  const t = req?.projectTitle || "your project";
  return `Your engineer is confirmed: ${engineerName || "Engineer"} — ${t}`;
}
function clientEngineerAcceptedHtml(req, engineerName, pmName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:26px;color:${TEXT}">Your engineer is confirmed</h1>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      Great news — <strong>${escapeHtml(engineerName || "your engineer")}</strong> has accepted the assignment.
      ${pmName ? `Your Project Manager, <strong>${escapeHtml(pmName)}</strong>, will coordinate everything and keep you updated in the chat.` : "Your Project Manager will coordinate everything and keep you updated in the chat."}
    </p>
    ${detailsTable(
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Project Manager", pmName || "") +
      keyval("Engineer", engineerName || "")
    )}
    ${button("Say hello in chat", chatUrl)}
  `;
  return wrapHtml(inner, "Engineer confirmed", CLIENT_GIF);
}

function pmsEngineerAcceptedSubject(req, engineerName) {
  return `Engineer confirmed: ${engineerName || "Engineer"} — ${req?.projectTitle || "Project"}`;
}
function pmsEngineerAcceptedHtml(req, engineerName, pmName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:22px;color:${TEXT}">Engineer Confirmed</h1>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      <strong>${escapeHtml(engineerName || "Engineer")}</strong> accepted this project${pmName ? ` (PM: ${escapeHtml(pmName)})` : ""}.
      Align on scope, milestones, and comms cadence in the chat.
    </p>
    ${detailsTable(
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Project Manager", pmName || "") +
      keyval("Engineer", engineerName || "")
    )}
    ${button("Open Chat", chatUrl)}
  `;
  return wrapHtml(inner, "Engineer confirmed", STAFF_LOGO);
}

function adminsEngineerAcceptedSubject(req, engineerName) {
  return `Engineer accepted: ${req?.projectTitle || "Project"} — ${engineerName || "Engineer"}`;
}
function adminsEngineerAcceptedHtml(req, engineerName, pmName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:22px;color:${TEXT}">Engineer Accepted</h1>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      The assigned engineer has accepted. Ensure calendars and billing are updated accordingly.
    </p>
    ${detailsTable(
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Project Manager", pmName || "") +
      keyval("Engineer", engineerName || "") +
      keyval("Status", "In progress — Engineer confirmed")
    )}
  `;
  return wrapHtml(inner, "Engineer accepted", STAFF_LOGO);
}

/* ============================================================================
 * Engineer in the Room — client / PMs / super-admins
 * ========================================================================== */

function clientEngineerInRoomSubject(req, engineerName) {
  return `${engineerName || "Your engineer"} just joined the chat`;
}
function clientEngineerInRoomHtml(req, engineerName, pmName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:26px;color:${TEXT}">
      ${escapeHtml(engineerName || "Your engineer")} is here 👋
    </h1>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      Your engineer has joined the chat${pmName ? ` alongside <strong>${escapeHtml(pmName)}</strong>` : ""}. 
      Share any files, links, or notes to kick things off.
    </p>
    ${detailsTable(
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Project Manager", pmName || "") +
      keyval("Engineer", engineerName || "")
    )}
    ${button("Open Chat", chatUrl)}
  `;
  return wrapHtml(inner, "Engineer joined", CLIENT_GIF);
}

function pmsEngineerInRoomSubject(req, engineerName) {
  return `Engineer joined room: ${engineerName || "Engineer"} — ${req?.projectTitle || "Project"}`;
}
function pmsEngineerInRoomHtml(req, engineerName, pmName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:22px;color:${TEXT}">Engineer in the Room</h1>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      <strong>${escapeHtml(engineerName || "Engineer")}</strong> is now in the chat${pmName ? ` (PM: ${escapeHtml(pmName)})` : ""}.
      Start Day-0 checklist: context, access, scope confirmation, timeline, and first deliverable.
    </p>
    ${detailsTable(
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Project Manager", pmName || "") +
      keyval("Engineer", engineerName || "")
    )}
    ${button("Open Chat", chatUrl)}
  `;
  return wrapHtml(inner, "Engineer joined", STAFF_LOGO);
}

function adminsEngineerInRoomSubject(req, engineerName) {
  return `Engineer joined: ${req?.projectTitle || "Project"} — ${engineerName || "Engineer"}`;
}
function adminsEngineerInRoomHtml(req, engineerName, pmName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:22px;color:${TEXT}">Engineer Joined Room</h1>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      The engineer has joined the client room. Monitor SLA and unblock access if needed.
    </p>
    ${detailsTable(
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Project Manager", pmName || "") +
      keyval("Engineer", engineerName || "") +
      keyval("Status", "Active — Delivery started")
    )}
  `;
  return wrapHtml(inner, "Engineer joined", STAFF_LOGO);
}

/* ============================================================================
 * Staff → Project completed
 * ========================================================================== */

function staffProjectCompletedSubject(req) {
  return `Completed: ${req?.projectTitle || "Project"}`;
}
function staffProjectCompletedHtml(req, pmName, engineerName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:22px;color:${TEXT}">Project Marked Complete</h1>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      The project has been closed out. Please complete post-delivery steps:
    </p>
    <ul style="margin:0 0 12px 20px;color:${MUTED};padding:0">
      <li>Archive final deliverables & transfer ownership where applicable</li>
      <li>Remove temporary access tokens, test credentials, and webhooks</li>
      <li>Log time & notes; update billing</li>
      <li>Quick retro: highlights, risks, suggestions</li>
    </ul>
    ${detailsTable(
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Client", `${(req?.firstName || "")} ${(req?.lastName || "")}`.trim()) +
      keyval("Project Manager", pmName || "") +
      keyval("Engineer", engineerName || "")
    )}
    ${button("Open Chat", chatUrl)}
  `;
  return wrapHtml(inner, "Project completed", STAFF_LOGO);
}

/* ============================================================================
 * NEW: Engineer Assigned (client)
 * ========================================================================== */

function clientEngineerAssignedSubject(req, engineerName) {
  const t = req?.projectTitle || "your project";
  return `Engineer assigned: ${engineerName || "Engineer"} — ${t}`;
}
function clientEngineerAssignedHtml(req, engineerName, pmName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:26px;color:${TEXT}">Your engineer is assigned</h1>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      We’ve assigned <strong>${escapeHtml(engineerName || "your engineer")}</strong> to your project.
      ${pmName ? `Your Project Manager, <strong>${escapeHtml(pmName)}</strong>, will coordinate delivery and keep you updated in the chat.` : "Your Project Manager will coordinate delivery and keep you updated in the chat."}
    </p>
    ${detailsTable(
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Project Manager", pmName || "") +
      keyval("Engineer", engineerName || "")
    )}
    ${button("Open chat", chatUrl)}
  `;
  return wrapHtml(inner, "Engineer assigned", CLIENT_GIF);
}

/* ============================================================================
 * Public API
 * ========================================================================== */

export async function emailClientNewRequest(req, pmName, engineerName) {
  if (!req?.email) return { skipped: true, reason: "no client email" };
  return safeSend({
    to: req.email,
    subject: clientNewRequestSubject(req),
    html: clientNewRequestHtml(req, pmName, engineerName),
  });
}

// keep both names for compatibility
export async function emailSuperAdminsNewRequest(req, superAdmins = [], pmName, engineerName) {
  const toList = superAdmins.map(a => a?.email).filter(Boolean);
  if (!toList.length) return { skipped: true, reason: "no superadmin emails" };
  return safeSend({
    to: toList,
    subject: adminsNewRequestSubject(req),
    html: adminsNewRequestHtml_NoPM(req, pmName, engineerName),
  });
}
export const emailSuperAdminsNewRequest_NoPM = emailSuperAdminsNewRequest;

export async function emailSuperAdminsAssigned(req, pmName, superAdmins = [], engineerName) {
  const toList = superAdmins.map(a => a?.email).filter(Boolean);
  if (!toList.length) return { skipped: true, reason: "no superadmin emails" };
  return safeSend({
    to: toList,
    subject: adminsAssignedSubject(req, pmName),
    html: adminsAssignedHtml(req, pmName, engineerName),
  });
}

export async function emailPMsBroadcastNewRequest(req, pmEmails = [], pmName, engineerName) {
  const list = pmEmails.filter(Boolean);
  if (!list.length) return { skipped: true, reason: "no pm emails" };

  const CHUNK = 50;
  const results = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK);
    const to = chunk[0];
    const bcc = chunk.slice(1);
    // eslint-disable-next-line no-await-  in-loop
    const r = await safeSend({
      to,
      bcc,
      subject: pmsBroadcastSubject(req),
      html: pmsBroadcastHtml(req, pmName, engineerName),
    });
    results.push(r);
  }
  return results;
}

export async function emailPMsOnPmAssigned(req, pmName, pmEmails = [], engineerName) {
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
      html: pmsAssignedHtml(req, pmName, engineerName),
    });
    results.push(r);
  }
  return results;
}

export async function emailClientThankYou(req, pmName, engineerName) {
  if (!req?.email) return { skipped: true, reason: "no client email" };
  return safeSend({
    to: req.email,
    subject: clientThankYouSubject(),
    html: clientThankYouHtml(req, pmName, engineerName),
  });
}

/* -------- Engineer Assigned (NEW) -------- */
export async function emailClientEngineerAssigned(req, engineerName, pmName) {
  if (!req?.email) return { skipped: true, reason: "no client email" };
  return safeSend({
    to: req.email,
    subject: clientEngineerAssignedSubject(req, engineerName),
    html: clientEngineerAssignedHtml(req, engineerName, pmName),
  });
}

/* -------- Engineer Accepted -------- */
export async function emailClientEngineerAccepted(req, engineerName, pmName) {
  if (!req?.email) return { skipped: true, reason: "no client email" };
  return safeSend({
    to: req.email,
    subject: clientEngineerAcceptedSubject(req, engineerName),
    html: clientEngineerAcceptedHtml(req, engineerName, pmName),
  });
}

export async function emailPMsEngineerAccepted(req, engineerName, pmName, pmEmails = []) {
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
      subject: pmsEngineerAcceptedSubject(req, engineerName),
      html: pmsEngineerAcceptedHtml(req, engineerName, pmName),
    });
    results.push(r);
  }
  return results;
}

export async function emailSuperAdminsEngineerAccepted(req, engineerName, pmName, superAdmins = []) {
  const toList = superAdmins.map(a => a?.email).filter(Boolean);
  if (!toList.length) return { skipped: true, reason: "no superadmin emails" };
  return safeSend({
    to: toList,
    subject: adminsEngineerAcceptedSubject(req, engineerName),
    html: adminsEngineerAcceptedHtml(req, engineerName, pmName),
  });
}

/* -------- Engineer in the Room -------- */
export async function emailClientEngineerInRoom(req, engineerName, pmName) {
  if (!req?.email) return { skipped: true, reason: "no client email" };
  return safeSend({
    to: req.email,
    subject: clientEngineerInRoomSubject(req, engineerName),
    html: clientEngineerInRoomHtml(req, engineerName, pmName),
  });
}

export async function emailPMsEngineerInRoom(req, engineerName, pmName, pmEmails = []) {
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
      subject: pmsEngineerInRoomSubject(req, engineerName),
      html: pmsEngineerInRoomHtml(req, engineerName, pmName),
    });
    results.push(r);
  }
  return results;
}

export async function emailSuperAdminsEngineerInRoom(req, engineerName, pmName, superAdmins = []) {
  const toList = superAdmins.map(a => a?.email).filter(Boolean);
  if (!toList.length) return { skipped: true, reason: "no superadmin emails" };
  return safeSend({
    to: toList,
    subject: adminsEngineerInRoomSubject(req, engineerName),
    html: adminsEngineerInRoomHtml(req, engineerName, pmName),
  });
}

/* -------- Staffs → Project completed -------- */
export async function emailStaffsProjectCompleted(req, pmName, engineerName, staffEmails = []) {
  const list = staffEmails.filter(Boolean);
  if (!list.length) return { skipped: true, reason: "no staff emails" };

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
      subject: staffProjectCompletedSubject(req),
      html: staffProjectCompletedHtml(req, pmName, engineerName),
    });
    results.push(r);
  }
  return results;
}

/* ============================================================================
 * CLIENT → PM assigned
 * ========================================================================== */
function clientPmAssignedSubject(req, pmName) {
  const t = req?.projectTitle || "your project";
  return `Your Project Manager is assigned: ${pmName || "PM"} — ${t}`;
}
function clientPmAssignedHtml(req, pmName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:26px;color:${TEXT}">Your Project Manager is here</h1>
    <p style="margin:0 0 10px 0;color:${MUTED}">
      <strong>${escapeHtml(pmName || "Your PM")}</strong> has been assigned to your project and will coordinate delivery and updates in the chat.
    </p>
    ${detailsTable(
      keyval("Project", req?.projectTitle || "Project") +
      keyval("Project Manager", pmName || "PM")
    )}
    ${button("Open Chat", chatUrl)}
    ${ctaBlock(
      "What happens next?",
      "Your PM will confirm scope, align milestones, and set the first deliverable. You can share files and notes in the chat.",
      "Go to Chat",
      chatUrl
    )}
  `;
  return wrapHtml(inner, "PM assigned", CLIENT_GIF);
}

/* ============================================================================
 * CLIENT → Project submitted & in Review (with /rate instruction)
 * ========================================================================== */
function clientProjectSubmittedSubject(req) {
  const t = req?.projectTitle || "your project";
  return `Submitted for review: ${t}`;
}
function clientProjectSubmittedHtml(req, pmName, engineerName) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:26px;color:${TEXT}">Your project is ready for review</h1>
    <p style="margin:0 0 12px 0;color:${MUTED}">
      We’ve marked <strong>${escapeHtml(req?.projectTitle || "your project")}</strong> as <strong>Submitted</strong>.
      ${pmName ? `Your PM <strong>${escapeHtml(pmName)}</strong>` : "Your PM"} will guide the final checks.
    </p>
    ${detailsTable(
      keyval("Project Manager", pmName || "PM") +
      keyval("Engineer", engineerName || "Engineer") +
      keyval("Status", "In Review")
    )}
    ${button("Open Chat to Review", chatUrl)}
    <p style="margin:12px 0 0;color:${MUTED}">
      To rate the team, open the chat and type <code style="background:#222;padding:2px 6px;border-radius:6px">/rate</code> then click <strong>Send</strong>.
    </p>
  `;
  return wrapHtml(inner, "Project in Review", CLIENT_GIF);
}

/* ============================================================================
 * PUBLIC API (new exports)
 * ========================================================================== */
export async function emailClientPmAssigned(req, pmName) {
  if (!req?.email) return { skipped: true, reason: "no client email" };
  return safeSend({
    to: req.email,
    subject: clientPmAssignedSubject(req, pmName),
    html: clientPmAssignedHtml(req, pmName),
  });
}

export async function emailClientProjectSubmitted(req, pmName, engineerName) {
  if (!req?.email) return { skipped: true, reason: "no client email" };
  return safeSend({
    to: req.email,
    subject: clientProjectSubmittedSubject(req),
    html: clientProjectSubmittedHtml(req, pmName, engineerName),
  });
}

// Simple, styled notification wrapper used by notify.service.js
export async function emailNotifyUser(to, subject, body, link) {
  const inner = `
    <h1 style="margin:0 0 10px 0;font-size:22px;color:${TEXT}">${escapeHtml(subject || "Notification")}</h1>
    <p style="margin:0 0 12px 0;color:${MUTED}">${escapeHtml(body || "")}</p>
    ${link ? button("Open", link) : ""}
  `;
  return safeSend({
    to,
    subject: subject || "Notification",
    html: wrapHtml(inner, subject || "Notification", STAFF_LOGO),
  });
}
