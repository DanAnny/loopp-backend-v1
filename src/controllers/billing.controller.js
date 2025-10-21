// backend/src/controllers/billing.controller.js
import Stripe from "stripe";
import { ProjectRequest } from "../models/ProjectRequest.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

// convert "199.99" -> 19999 (smallest unit); handles zero-decimal currencies (e.g., JPY)
function toStripeAmount(decimalStr, currency) {
  const cur = (currency || "USD").toUpperCase();
  const zeroDecimal = new Set(["JPY", "KRW", "VND"]);
  if (zeroDecimal.has(cur)) return Math.round(Number(decimalStr));
  return Math.round(Number(decimalStr) * 100);
}

export async function createHostedInvoice(req, res) {
  try {
    const { projectId, amountDecimal, currency = "usd", memo = "" } = req.body;

    const project = await ProjectRequest.findById(projectId).lean();
    if (!project) return res.status(404).json({ message: "Project not found" });

    const clientEmail = project.email;
    if (!clientEmail) return res.status(400).json({ message: "Missing client email" });

    const amountMinor = toStripeAmount(amountDecimal, currency);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      return res.status(400).json({ message: "Amount must be greater than 0" });
    }

    // 1) find or create customer
    const { data } = await stripe.customers.list({ email: clientEmail, limit: 1 });
    const customer =
      data[0] ||
      (await stripe.customers.create({
        email: clientEmail,
        name: `${project.firstName || ""} ${project.lastName || ""}`.trim() || undefined,
        metadata: { projectId: String(projectId) },
      }));

    // 2) create invoice item
    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: amountMinor,
      currency: currency.toLowerCase(),
      description: memo || `Invoice for ${project.projectTitle || "project"}`,
      metadata: { projectId: String(projectId) },
    });

    // 3) create & finalize invoice → hosted link
    const invoice = await stripe.invoices.create({
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: 14,
      metadata: { projectId: String(projectId) },
    });

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    // Optional: email it straight from Stripe
    // await stripe.invoices.sendInvoice(finalized.id);

    return res.json({
      invoiceId: finalized.id,
      hostedUrl: finalized.hosted_invoice_url,
      invoiceUrl: finalized.invoice_pdf,
      status: finalized.status,
    });
  } catch (err) {
    console.error("Stripe invoice error:", err);
    return res.status(500).json({ message: err.message || "Stripe error" });
  }
}
