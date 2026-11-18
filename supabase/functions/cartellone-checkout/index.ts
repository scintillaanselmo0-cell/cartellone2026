// Edge Function: crea la sessione di pagamento Stripe per i numeri scelti.
// Deploy:  supabase functions deploy cartellone-checkout
// Secrets richiesti: STRIPE_SECRET_KEY, PREZZO_CENTESIMI (es. 1000), SITO_URL
//   (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono già disponibili di default)

import Stripe from "https://esm.sh/stripe@16?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const stripe = new Stripe(Deno.env.get("CART_STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
const PREZZO = parseInt(Deno.env.get("PREZZO_CENTESIMI") || "1000", 10); // 10,00 €
const SITO = (Deno.env.get("SITO_URL") || "").replace(/\/$/, "");
const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { numeri, nome, contatto, email } = await req.json();

    // --- validazione ---
    if (!Array.isArray(numeri) || numeri.length === 0) return json({ error: "Nessun numero selezionato." }, 400);
    const nums = [...new Set(numeri.map((n: unknown) => parseInt(String(n), 10)))];
    if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 90)) return json({ error: "Numeri non validi." }, 400);
    if (!nome || String(nome).trim().length < 2) return json({ error: "Nome mancante." }, 400);
    if (!contatto || String(contatto).replace(/\D/g, "").length < 6) return json({ error: "Contatto non valido." }, 400);
    if (!email || !/.+@.+\..+/.test(String(email))) return json({ error: "Email non valida." }, 400);

    // --- libera gli hold scaduti su questi numeri ---
    await supa.from("cartellone_prenotazioni").delete()
      .in("numero", nums).eq("status", "pending").lt("hold_expires_at", new Date().toISOString());

    // --- quali sono già presi (pagati o in pagamento ancora valido)? ---
    const { data: busy } = await supa.from("cartellone_prenotazioni")
      .select("numero,status,hold_expires_at").in("numero", nums);
    const taken = (busy || [])
      .filter((r) => r.status === "paid" || (r.status === "pending" && new Date(r.hold_expires_at) > new Date()))
      .map((r) => r.numero);
    if (taken.length) return json({ taken });

    // --- prenotazione temporanea (hold 31 min): insert atomico, l'indice UNIQUE blocca i doppioni ---
    const hold = new Date(Date.now() + 31 * 60 * 1000).toISOString();
    const rows = nums.map((numero) => ({
      numero, nome, contatto, email, status: "pending", amount_cents: PREZZO, hold_expires_at: hold,
    }));
    const { error: insErr } = await supa.from("cartellone_prenotazioni").insert(rows);
    if (insErr) {
      // un numero è stato preso nel frattempo
      const { data: now } = await supa.from("cartellone_prenotazioni").select("numero").in("numero", nums);
      return json({ taken: (now || []).map((r) => r.numero) });
    }

    // --- sessione Stripe Checkout ---
    const base = SITO || new URL(req.url).origin;
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: email,
        line_items: [{
          quantity: nums.length,
          price_data: {
            currency: "eur",
            unit_amount: PREZZO,
            product_data: {
              name: "Cartellone della Fortuna — numero",
              description: "Numeri scelti: " + nums.sort((a, b) => a - b).join(", "),
            },
          },
        }],
        metadata: { numeri: nums.join(","), nome, contatto },
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
        success_url: base + "/?stato=ok",
        cancel_url: base + "/?stato=annullato",
      });
    } catch (e) {
      // rollback dell'hold se Stripe fallisce
      await supa.from("cartellone_prenotazioni").delete().in("numero", nums).eq("status", "pending").is("stripe_session_id", null);
      throw e;
    }

    // collega la sessione agli hold
    await supa.from("cartellone_prenotazioni").update({ stripe_session_id: session.id })
      .in("numero", nums).eq("status", "pending").is("stripe_session_id", null);

    return json({ url: session.url });
  } catch (e) {
    console.error(e);
    return json({ error: "Errore interno." }, 500);
  }
});
