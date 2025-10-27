// backend/src/lib/mailer.js
// No-op mailer by default. Flip ENABLE_EMAIL to true later or use config.smtp.enabled.

import nodemailer from "nodemailer";
import { config } from "../config/env.js";

const ENABLE_EMAIL = Boolean(config?.smtp?.enabled); // keep false until you're ready

let transporter = null;

function getTransporter() {
  if (!ENABLE_EMAIL) return null;
  if (transporter) return transporter;

  const { host, port, user, pass } = config.smtp || {};
  if (!host || !port || !user || !pass) {
    // Missing creds — stay no-op
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: Number(port) === 465, // common default for SMTPS
    auth: { user, pass },
  });

  return transporter;
}

/**
 * Send a simple email. No-ops when email is disabled.
 * @param {Object} opts
 * @param {string|string[]} opts.to
 * @param {string} opts.subject
 * @param {string} [opts.text]
 * @param {string} [opts.html]
 */
export async function sendMail({ to, subject, text = "", html = "" }) {
  const tx = getTransporter();
  if (!tx) {
    // Mail disabled — do nothing, but log for visibility
    if (process.env.NODE_ENV !== "test") {
      console.debug("[mailer] (disabled) would send →", { to, subject });
    }
    return { disabled: true };
  }

  const from = config?.smtp?.mailFrom || "no-reply@example.com";
  const info = await tx.sendMail({ from, to, subject, text, html });
  return { messageId: info.messageId };
}

/**
 * Small helper for future templated emails (kept as a no-op now).
 */
export async function sendTemplatedMail(templateName, { to, subject, vars = {} }) {
  const text = `[${templateName}] ${subject}\n\n${JSON.stringify(vars, null, 2)}`;
  return sendMail({ to, subject, text });
}

/* ---------- Aliases to match existing imports elsewhere ---------- */
// Many places import { sendEmail } — provide it as an alias to sendMail:
export const sendEmail = sendMail;
// If you someday used sendTemplateEmail elsewhere, this covers that too:
export const sendTemplateEmail = sendTemplatedMail;
