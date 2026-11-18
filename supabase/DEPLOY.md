# Cartellone — attivare i pagamenti Stripe

Tre blocchi: SQL, funzioni, webhook. ~15 minuti.

## 1. SQL
Apri il **SQL Editor** del progetto Scintilla (`qorswaabqqcxpsmngbpo`) ed esegui
`migration_pagamenti.sql`.

## 2. Secrets (chiavi) su Supabase
Prendi la **Secret key** di Stripe (account Scintilla): Stripe → Developers → API keys →
*Secret key* (`sk_live_...` in produzione, `sk_test_...` per le prove).

Dal terminale, nella cartella del progetto:

```bash
supabase login
supabase link --project-ref qorswaabqqcxpsmngbpo

supabase secrets set CART_STRIPE_SECRET_KEY="sk_live_..."
supabase secrets set PREZZO_CENTESIMI="1000"            # 10,00 € a numero
supabase secrets set SITO_URL="https://scintillaanselmo0-cell.github.io/cartellone2026"
```

(Le chiavi NON finiscono nel codice: restano come secret su Supabase.)

## 3. Deploy delle funzioni

```bash
supabase functions deploy cartellone-checkout
supabase functions deploy cartellone-webhook --no-verify-jwt
```

## 4. Webhook Stripe
Stripe → **Developers → Webhooks → Add endpoint**
- **URL:** `https://qorswaabqqcxpsmngbpo.supabase.co/functions/v1/cartellone-webhook`
- **Eventi:** `checkout.session.completed` e `checkout.session.expired`

Copia il **Signing secret** (`whsec_...`) e salvalo:

```bash
supabase secrets set CART_STRIPE_WEBHOOK_SECRET="whsec_..."
```

(Dopo aver impostato questo secret, ridistribuisci il webhook se necessario:
`supabase functions deploy cartellone-webhook --no-verify-jwt`)

## 5. Prova
- In modalità **test** (chiavi `sk_test_` e webhook sul test), compra un numero con la
  carta di prova `4242 4242 4242 4242`, data futura, CVC qualsiasi.
- Il numero deve diventare **in pagamento** (ambra) durante il checkout e **prenotato**
  (oro) dopo il pagamento. Nel gestionale compare con stato *Pagato*.
- Passa alle chiavi **live** quando tutto funziona.

## Note
- Durante il pagamento i numeri sono bloccati per 31 minuti; se non paghi, si liberano
  da soli (evento `checkout.session.expired`).
- L'indice UNIQUE sul numero impedisce i doppioni anche con acquisti simultanei.
