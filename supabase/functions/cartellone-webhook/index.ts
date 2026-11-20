// Edge Function: webhook Stripe. Conferma il pagamento, prenota i numeri
// e invia al cliente l'email di conferma con i numeri acquistati.
//
// Deploy:  supabase functions deploy cartellone-webhook --no-verify-jwt
// Secrets richiesti:
//   CART_STRIPE_SECRET_KEY, CART_STRIPE_WEBHOOK_SECRET
//   RESEND_API_KEY                (chiave API Resend, per inviare le email)
//   MAIL_FROM   (opzionale)       es. "Cartellone della Fortuna <cartellone@tuodominio.it>"
//   MAIL_BCC    (opzionale)       una tua email per ricevere copia di ogni conferma
//   (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sono già disponibili)
//
// Su Stripe → Developers → Webhooks → Add endpoint:
//   URL:    https://<project>.supabase.co/functions/v1/cartellone-webhook
//   Eventi: checkout.session.completed, checkout.session.expired

import Stripe from "https://esm.sh/stripe@16?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("CART_STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
const WH = Deno.env.get("CART_STRIPE_WEBHOOK_SECRET")!;
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
      // pagamento confermato: i numeri ancora 'pending' di questa sessione diventano 'paid'.
      // Filtrando su status='pending' rendiamo l'operazione idempotente:
      // se Stripe reinvia l'evento, non ci sono più righe da aggiornare e non si rimanda l'email.
      const { data: confermati } = await supa.from("cartellone_prenotazioni")
        .update({ status: "paid", hold_expires_at: null })
        .eq("stripe_session_id", s.id)
        .eq("status", "pending")
        .select("numero,nome,email");

      if (confermati && confermati.length) {
        // l'email non deve bloccare il webhook: se fallisce, il pagamento resta comunque registrato
        try {
          await inviaConferma(s, confermati);
        } catch (e) {
          console.error("Invio email di conferma fallito:", e);
        }
      }
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

// ---------- email di conferma (Resend) ----------
async function inviaConferma(
  s: Stripe.Checkout.Session,
  rows: Array<{ numero: number; nome: string | null; email: string | null }>,
) {
  const KEY = Deno.env.get("RESEND_API_KEY");
  if (!KEY) { console.warn("RESEND_API_KEY mancante: email non inviata."); return; }

  const FROM = Deno.env.get("RESEND_FROM") || Deno.env.get("MAIL_FROM") || "Cartellone della Fortuna <onboarding@resend.dev>";
  const BCC = (Deno.env.get("MAIL_BCC") || "").trim();

  const to = s.customer_details?.email || (s.customer_email as string | null) || rows[0]?.email || "";
  if (!to) { console.warn("Nessuna email destinatario."); return; }

  const nome = String(s.metadata?.nome || rows[0]?.nome || "").trim();
  const saluto = nome ? `Ciao ${nome},` : "Ciao,";
  const numeri = rows.map((r) => r.numero).sort((a, b) => a - b);
  const plurale = numeri.length === 1 ? "il tuo numero" : "i tuoi numeri";

  const chips = numeri.map((n) =>
    `<td style="padding:4px"><div style="width:52px;height:52px;line-height:52px;text-align:center;border-radius:12px;background:#f5b63f;color:#161308;font-family:Arial,Helvetica,sans-serif;font-weight:800;font-size:22px">${n}</div></td>`
  ).join("");

  const html = `<!doctype html><html><body style="margin:0;background:#0c0c0e;padding:28px 0;font-family:Arial,Helvetica,sans-serif;color:#eceae6">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#131316;border:1px solid #26262b;border-radius:18px;overflow:hidden">
      <tr><td style="padding:26px 30px 6px">
        <div style="font-size:13px;letter-spacing:.22em;color:#f5b63f;font-weight:700;text-transform:uppercase">Pagamento confermato</div>
        <h1 style="margin:10px 0 0;font-size:24px;color:#fff">Il Cartellone della Fortuna</h1>
      </td></tr>
      <tr><td style="padding:14px 30px 2px;font-size:15px;line-height:1.55;color:#c9c7c2">
        ${saluto}<br>abbiamo ricevuto il tuo pagamento. Ecco ${plurale} in gioco:
      </td></tr>
      <tr><td style="padding:18px 26px 6px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>${chips}</tr></table>
      </td></tr>
      <tr><td style="padding:12px 30px 4px;font-size:15px;line-height:1.6;color:#c9c7c2">
        Vince chi ha il numero uguale al <b style="color:#fff">primo estratto sulla Ruota di Napoli</b> del Lotto di <b style="color:#fff">giovedì 24 dicembre 2026</b>.
        Se è il tuo, ti contattiamo noi per realizzare il sito.
      </td></tr>
      <tr><td style="padding:16px 30px 26px">
        <div style="border-top:1px solid #26262b;padding-top:16px;font-size:13px;color:#8b8982">
          In bocca al lupo! — <span style="color:#f5b63f;font-weight:700">SCINTILLA.DIGITAL.WEB</span><br>
          Instagram @scintilla.digital.web · WhatsApp +39 376 247 4257
        </div>
      </td></tr>
    </table>
    <div style="font-size:11px;color:#55545a;margin-top:14px">Email automatica, non rispondere a questo messaggio.</div>
  </td></tr></table></body></html>`;

  const payload: Record<string, unknown> = {
    from: FROM,
    to: [to],
    subject: `Confermato: ${plurale} — Il Cartellone della Fortuna`,
    html,
  };
  if (BCC) payload.bcc = [BCC];

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error("Resend errore", res.status, await res.text());
}
