// controllers/stripe.webhook.controller.js
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

export function stripeWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "invoice.paid":
      // mark project invoice as paid in DB (event.data.object.id)
      break;
    case "invoice.payment_failed":
      // notify PM / leave note in room
      break;
    default:
      break;
  }
  res.json({ received: true });
}
