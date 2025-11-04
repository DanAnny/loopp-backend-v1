import nodemailer from "nodemailer";
import { config } from "../config/env.js";

let transporter = null;

export function getMailer() {
  if (!config.smtp.enabled) return null;
  if (transporter) return transporter;

  // Brevo SMTP relay
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: Number(config.smtp.port || 587),
    secure: String(config.smtp.port) === "465", // true for 465, false for 587
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
  });

  return transporter;
}

export async function sendMail({ to, subject, html, text }) {
  const mailer = getMailer();
  if (!mailer) return { queued: false, reason: "SMTP disabled" };

  const opts = {
    from: config.smtp.mailFrom,
    to,
    subject,
    text: text || stripHtml(html || ""),
    html: html || (text ? `<pre>${escapeHtml(text)}</pre>` : ""),
  };

  try {
    const info = await mailer.sendMail(opts);
    return { queued: true, messageId: info.messageId };
  } catch (e) {
    // don't crash app on mail failures
    console.error("MAIL SEND ERROR:", e.message);
    return { queued: false, error: e.message };
  }
}

function stripHtml(s = "") {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function escapeHtml(s = "") {
  return s.replace(/[&<>'"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;" }[c]));
}
