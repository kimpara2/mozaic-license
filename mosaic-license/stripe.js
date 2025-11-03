import { supabase } from "../api/_supabase.js";
import { stripe } from "../api/_stripe.js";

export const config = { api: { bodyParser: false } };

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on("data", c => chunks.push(c));
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const sig = req.headers["stripe-signature"];
  const buf = await buffer(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      buf,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  try {
    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const stripeCustomerId = sub.customer;
      const status = sub.status; // active/trialing/past_due/canceled

      const { data: cust } = await supabase
        .from("customers").select("id").eq("stripe_customer_id", stripeCustomerId).maybeSingle();

      if (cust) {
        const newStatus =
          (status === "active" || status === "trialing") ? "active" :
          (status === "canceled") ? "canceled" : "suspended";
        await supabase.from("licenses").update({ status: newStatus }).eq("customer_id", cust.id);
      }
    }

    if (event.type === "invoice.payment_failed") {
      const inv = event.data.object;
      const stripeCustomerId = inv.customer;
      const { data: cust } = await supabase
        .from("customers").select("id").eq("stripe_customer_id", stripeCustomerId).maybeSingle();
      if (cust) {
        await supabase.from("licenses").update({ status: "suspended" }).eq("customer_id", cust.id);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const stripeCustomerId = sub.customer;
      const { data: cust } = await supabase
        .from("customers").select("id").eq("stripe_customer_id", stripeCustomerId).maybeSingle();
      if (cust) {
        await supabase.from("licenses").update({ status: "canceled" }).eq("customer_id", cust.id);
      }
    }

    res.json({ received: true });
  } catch (e) {
    console.error(e);
    res.status(500).send("Internal Error");
  }
}