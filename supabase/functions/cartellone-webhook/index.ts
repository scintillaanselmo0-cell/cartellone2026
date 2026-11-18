// Edge Function: webhook Stripe. Conferma il pagamento e prenota i numeri.
// Deploy:  supabase functions deploy cartellone-webhook --no-verify-jwt
// Secrets richiesti: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
//   (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono già disponibili)
//
// Su Stripe → Developers → Webhooks → Add endpoint:
//   URL:    https://<project>.supabase.co/functions/v1/cartellone-webhook
//   Eventi: checkout.session.completed, checkout.session.expired
// Copia il "Signing secret" (whsec_...) in STRIPE_WEBHOOK_SECRET.

import Stripe from "https://esm.sh/stripe@16?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
const WH = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig!, WH);
  } catch (e) {
    console.error("Firma non valida", e);
    return new Response("bad signature", { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object as Stripe.Checkout.Session;
      // pagamento confermato: i numeri di questa sessione diventano 'paid'
      await supa.from("cartellone_prenotazioni")
        .update({ status: "paid", hold_expires_at: null })
        .eq("stripe_session_id", s.id);
    } else if (event.type === "checkout.session.expired") {
      const s = event.data.object as Stripe.Checkout.Session;
      // pagamento abbandonato: libera i numeri ancora in hold
      await supa.from("cartellone_prenotazioni").delete()
        .eq("stripe_session_id", s.id).eq("status", "pending");
    }
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
  return new Response("ok", { status: 200 });
});
