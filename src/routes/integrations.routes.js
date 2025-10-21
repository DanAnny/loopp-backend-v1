// backend/src/routes/integrations.routes.js
import express from "express";
import { requireAuth } from "../middleware/auth.middleware.js";
import { createHostedInvoice } from "../controllers/billing.controller.js";
import { createZoomMeeting } from "../controllers/zoom.controller.js";
import { stripeWebhook } from "../controllers/stripe.webhook.controller.js"; // <-- new
import { requirePm } from "../middleware/role.middleware.js";

const router = express.Router();

router.post("/billing/invoices", requireAuth, createHostedInvoice);
router.post("/zoom/meetings", requireAuth, requirePm, createZoomMeeting);

// Stripe webhook does NOT use requireAuth, Stripe needs to reach it directly
router.post("/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);

export default router
