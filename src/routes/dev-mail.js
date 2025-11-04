// src/routes/dev-mail.js
import express from "express";
import { emailClientNewRequest } from "../services/email.service.js";

const r = express.Router();

r.post("/dev/test-mail", async (req, res) => {
  try {
    const to = req.body.to;
    if (!to) return res.status(400).json({ ok: false, error: "to required" });

    const resp = await emailClientNewRequest({
      email: to,
      firstName: "Test",
      lastName: "User",
      projectTitle: "SMTP Check",
    });

    res.json({ ok: true, resp });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default r;
