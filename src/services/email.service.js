import nodemailer from "nodemailer";
import { config } from "../config/env.js";

/**
 * Build a transport only if SMTP is enabled & creds exist.
 * Works with Brevo (Sendinblue) SMTP out of the box.
 */
function buildTransport() {
  if (!config.smtp?.enabled) return null;
  const { host, port, user, pass } = config.smtp;

  if (!host || !port || !user || !pass) {
    console.warn("[mail] SMTP enabled but credentials are missing. Emails will be skipped.");
    return null;
  }

  // Brevo recommends TLS on 587. If you use port 465, set secure: true
  const secure = String(port) === "465";
  return nodemailer.createTransport({
    host,
    port: Number(port),
    secure,
    auth: { user, pass },
  });
}

const transport = buildTransport();

/** No-op send when transport is unavailable */
async function safeSendMail(opts) {
  if (!transport) {
    // Silently succeed to avoid crashing flows if email is disabled
    return { skipped: true };
  }
  return transport.sendMail(opts);
}

/** Small helper to standardize From header */
function fromAddress() {
  const mailFrom = config.smtp?.mailFrom || "no-reply@localhost";
  // You can brand this however you like
  return `"Loopp" <${mailFrom}>`;
}

/* ---------------------------------- TEMPLATES ---------------------------------- */

function clientNewRequestSubject(req) {
  const title = req.projectTitle || "New project";
  return `We received your request: ${title}`;
}

function clientNewRequestHtml(req) {
  const title = req.projectTitle || "New project";
  const name = `${req.firstName || ""} ${req.lastName || ""}`.trim() || "there";
  const due = req.completionDate ? new Date(req.completionDate).toDateString() : "—";
  return `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.6">
      <h2>Thanks ${name}, we’ve got your request ✅</h2>
      <p><strong>Title:</strong> ${title}</p>
      <p><strong>Target date:</strong> ${due}</p>
      <p>We’re assigning a Project Manager and will follow up shortly in your chat room.</p>
      <p style="color:#666">If you didn’t make this request, please reply to this email.</p>
      <hr/>
      <p>— Team Loopp</p>
    </div>
  `;
}

function adminsNewRequestSubject(req) {
  const title = req.projectTitle || "Untitled";
  return `New request: ${title} — ${req.firstName || ""} ${req.lastName || ""}`.trim();
}

function adminsNewRequestHtml(req) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.6">
      <h3>New Project Request</h3>
      <ul>
        <li><strong>Client:</strong> ${req.firstName || ""} ${req.lastName || ""} (${req.email || "n/a"})</li>
        <li><strong>Title:</strong> ${req.projectTitle || "Untitled"}</li>
        <li><strong>Target date:</strong> ${req.completionDate || "—"}</li>
        <li><strong>Request ID:</strong> ${req._id}</li>
      </ul>
      <p>Open in Admin → /admin/projects/${req._id}</p>
    </div>
  `;
}

function pmsBroadcastSubject(req) {
  return `New client request available: ${req.projectTitle || "Project"}`;
}

function pmsBroadcastHtml(req) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.6">
      <h3>New Request Available</h3>
      <p><strong>${req.firstName || ""} ${req.lastName || ""}</strong> submitted “${req.projectTitle || "Project"}”.</p>
      <p>Join the room to assist if you’re available.</p>
      <p>Request ID: ${req._id}</p>
    </div>
  `;
}

function clientThankYouSubject(req) {
  return `Thanks! Your project is complete`;
}

function clientThankYouHtml(req) {
  const title = req.projectTitle || "your project";
  return `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.6">
      <h2>Project completed 🎉</h2>
      <p>Thanks for working with us. We’ve marked <strong>${title}</strong> as complete.</p>
      <p>Your feedback helps us improve. If you have any follow-up requests, just reply or reopen the chat.</p>
      <hr/>
      <p>— Team Loopp</p>
    </div>
  `;
}

/* ---------------------------------- EXPORTS ---------------------------------- */

/**
 * Notifies the client that their request was received.
 * @param {import("../models/ProjectRequest.js").ProjectRequest & {email:string}} req
 */
export async function emailClientNewRequest(req) {
  if (!req?.email) return { skipped: true };
  return safeSendMail({
    from: fromAddress(),
    to: req.email,
    subject: clientNewRequestSubject(req),
    html: clientNewRequestHtml(req),
  });
}

/**
 * Notifies super admins (array of users with emails) about a new request.
 * @param {*} req
 * @param {Array<{email:string, firstName?:string, lastName?:string}>} superAdmins
 */
export async function emailSuperAdminsNewRequest(req, superAdmins = []) {
  const toList = superAdmins.map(x => x.email).filter(Boolean);
  if (!toList.length) return { skipped: true };
  return safeSendMail({
    from: fromAddress(),
    to: toList,
    subject: adminsNewRequestSubject(req),
    html: adminsNewRequestHtml(req),
  });
}

/**
 * Optional broadcast to PMs when a new request arrives.
 * You can disable this by not calling it, or keep it as FYI.
 * @param {*} req
 * @param {string[]} pmEmails
 */
export async function emailPMsBroadcastNewRequest(req, pmEmails = []) {
  const toList = pmEmails.filter(Boolean);
  if (!toList.length) return { skipped: true };
  return safeSendMail({
    from: fromAddress(),
    bcc: toList, // use BCC to avoid reply-all storms
    subject: pmsBroadcastSubject(req),
    html: pmsBroadcastHtml(req),
  });
}

/**
 * “Thank you” note to the client after completion.
 * @param {*} req
 */
export async function emailClientThankYou(req) {
  if (!req?.email) return { skipped: true };
  return safeSendMail({
    from: fromAddress(),
    to: req.email,
    subject: clientThankYouSubject(req),
    html: clientThankYouHtml(req),
  });
}
