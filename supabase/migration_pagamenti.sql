-- ============================================================
--  CARTELLONE DELLA FORTUNA — Pagamenti Stripe
--  Esegui nel SQL Editor del progetto Scintilla (qorswaabqqcxpsmngbpo).
--  Idempotente: puoi rilanciarlo senza problemi.
-- ============================================================

-- 1) Colonne per stato pagamento e hold temporaneo
alter table cartellone_prenotazioni add column if not exists status text not null default 'paid';
alter table cartellone_prenotazioni add column if not exists stripe_session_id text;
alter table cartellone_prenotazioni add column if not exists amount_cents int;
alter table cartellone_prenotazioni add column if not exists hold_expires_at timestamptz;

-- (le prenotazioni gratuite esistenti restano 'paid' di default)

-- 2) RLS: niente più lettura/scrittura pubblica diretta della tabella completa.
--    Il pubblico legge solo la vista sicura qui sotto; a scrivere è la Edge Function (service_role).
drop policy if exists "lettura pubblica" on cartellone_prenotazioni;
drop policy if exists "prenotazione pubblica" on cartellone_prenotazioni;

-- Il super admin del gestionale può leggere tutto (contatti inclusi)
drop policy if exists "cartellone sa select" on cartellone_prenotazioni;
create policy "cartellone sa select" on cartellone_prenotazioni for select
using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.role = 'super_admin'));

-- Il super admin può cancellare una prenotazione (libera il numero)
drop policy if exists "cartellone cancellazione super admin" on cartellone_prenotazioni;
create policy "cartellone cancellazione super admin" on cartellone_prenotazioni for delete
using (exists (select 1 from profiles p where p.user_id = auth.uid() and p.role = 'super_admin'));

-- Il super admin può inserire una prenotazione manuale (es. pagamento in contanti)
drop policy if exists "cartellone sa insert" on cartellone_prenotazioni;
create policy "cartellone sa insert" on cartellone_prenotazioni for insert
with check (exists (select 1 from profiles p where p.user_id = auth.uid() and p.role = 'super_admin'));

-- 3) Vista pubblica: solo numero, stato e nome di battesimo (niente telefono/email).
--    Mostra i pagati e i "pending" ancora validi (hold non scaduto).
drop view if exists cartellone_board;
create view cartellone_board
with (security_invoker = off) as
  select numero,
         status,
         case when status = 'paid' then split_part(coalesce(nome,''),' ',1) else null end as nome
  from cartellone_prenotazioni
  where status = 'paid'
     or (status = 'pending' and hold_expires_at > now());

grant select on cartellone_board to anon, authenticated;
