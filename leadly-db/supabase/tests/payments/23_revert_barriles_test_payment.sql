-- Prueba de 20261020120000_revert_barriles_sandbox_test_payment.sql en un Postgres
-- descartable (nunca toca una base real). Usa el esquema REAL de `payments` (migraciones
-- del servicio, ya aplicadas por el llamador) y un esquema `public` MINIMO que replica lo que
-- importa: la factura de plataforma, sus intentos, la suscripcion y el trigger real de
-- activacion (copia fiel de 20261013180000). Se ejecuta con MIG_REVERT=<ruta de la migracion>.
\set ON_ERROR_STOP off
set client_min_messages = notice;

create or replace function pg_temp.ok(p_name text, p_cond boolean) returns void language plpgsql as $$
begin
  if p_cond then raise notice 'PASS %', p_name; else raise notice 'FAIL: %', p_name; end if;
end $$;

create table public.billing_subscriptions (id uuid primary key, status text not null, plan_id uuid,
  current_period_start timestamptz, current_period_end timestamptz, updated_at timestamptz not null default now());
create table public.payment_invoices (id uuid primary key, status text not null, payer_tenant_id uuid not null,
  subscription_id uuid, provider_transaction_id text, provider_payment_method text, provider_payment_data jsonb,
  payments_link_id uuid, amount_cents bigint, updated_at timestamptz not null default now());
create unique index payment_invoices_provider_transaction_uidx on public.payment_invoices (provider_transaction_id) where provider_transaction_id is not null;
create table public.payment_attempts (id uuid primary key default gen_random_uuid(), invoice_id uuid not null references public.payment_invoices(id) on delete cascade,
  provider_transaction_id text, status text);

-- copia fiel del trigger de activacion vigente (solo PENDING_PAYMENT/PAST_DUE se tocan)
create or replace function public.activate_subscription_on_invoice_paid() returns trigger language plpgsql as $$
begin
  if new.status = 'PAID' and old.status is distinct from 'PAID' and new.subscription_id is not null then
    update public.billing_subscriptions set status = 'ACTIVE',
      current_period_start = case when current_period_end is null then now() else current_period_start end,
      current_period_end = case when current_period_end is null then now() + interval '1 month' else current_period_end end
    where id = new.subscription_id and status in ('PENDING_PAYMENT', 'PAST_DUE');
  end if;
  return new;
end $$;
create trigger payment_invoices_activate_subscription after update on public.payment_invoices
  for each row execute function public.activate_subscription_on_invoice_paid();

\set mig `echo "$MIG_REVERT"`

-- escenario = lo que dejo la prueba real en produccion
create or replace function pg_temp.scenario(p_env text default 'sandbox', p_hist int default 3, p_extra_attempt boolean default false) returns void language plpgsql as $$
declare
  c_invoice uuid := '5851bd75-6fd7-4ae8-bae6-f2ec705e9010'; c_link uuid := '643bcb69-5d0e-4272-9f39-2a30b3565bf6';
  c_client uuid := 'd01aaca8-4594-4f87-b5a2-4de093fc547e'; c_payer uuid := '9c79437d-1c19-4edc-bc1f-0dc06094823a';
  c_sub uuid := '82771b8f-6cb0-4a7d-99c3-06cac816cd87'; c_tx text := '12055712-1792527040-34421';
  v_event bigint; v_deliv uuid;
begin
  insert into public.billing_subscriptions (id, status, current_period_start, current_period_end, updated_at)
    values (c_sub, 'ACTIVE', '2026-10-10 05:00+00', '2026-11-10 05:00+00', '2026-10-13 19:50:00.969726+00') on conflict do nothing;
  insert into public.payment_invoices (id, status, payer_tenant_id, subscription_id, provider_transaction_id, provider_payment_method, provider_payment_data, payments_link_id, amount_cents)
    values (c_invoice, 'PENDING', c_payer, c_sub, null, null, null, null, 14000000) on conflict do nothing;
  insert into payments.clients (id, name, api_key_hash, key_prefix, signing_secret_name, kind, callback_url)
    values (c_client, 'Leadly (interno)', repeat('b', 64), 'lxy_pay_te', 'payments/x/signing', 'internal', 'https://x.supabase.co/functions/v1/payments-internal') on conflict do nothing;
  insert into payments.payment_links (id, client_id, wompi_link_id, external_reference, idempotency_key, request_hash, amount_in_cents, currency, environment, name, description, status, paid_transaction_id)
    values (c_link, c_client, 'test_bbSu9I', 'invoice:' || c_invoice, 'k', 'h', 14000000, 'COP', p_env, 'n', 'd', 'paid', c_tx) on conflict do nothing;
  insert into payments.events (classification, link_id, wompi_link_id, transaction_id, tx_status, raw) values ('processed', c_link, 'test_bbSu9I', c_tx, 'APPROVED', '{}') returning id into v_event;
  insert into payments.link_status_history (link_id, to_status, cause, event_id)
    select c_link, 'x', 'c', case when g = p_hist then v_event end from generate_series(1, p_hist) g;
  insert into payments.deliveries (event_id, client_id, link_id, url, body, body_sha256, status) values (v_event, c_client, c_link, 'https://x', '{}', 'sha', 'delivered') returning id into v_deliv;
  insert into payments.delivery_attempts (delivery_id, attempt, http_status) values (v_deliv, 1, 200);
  -- el pago real: la factura pasa a PAID con los datos de la transaccion + un intento
  update public.payment_invoices set status = 'PAID', provider_transaction_id = c_tx, provider_payment_method = 'CARD',
    provider_payment_data = '{"id":"x"}', payments_link_id = c_link where id = c_invoice;
  insert into public.payment_attempts (id, invoice_id, provider_transaction_id, status) values ('7ad20c61-809f-47ae-acf8-d6493a1231b4', c_invoice, c_tx, 'APPROVED');
  if p_extra_attempt then insert into public.payment_attempts (invoice_id, provider_transaction_id, status) values (c_invoice, 'otra', 'DECLINED'); end if;
end $$;

create or replace function pg_temp.reset() returns void language plpgsql as $$
begin
  alter table payments.delivery_attempts disable trigger delivery_attempts_append_only;
  alter table payments.deliveries disable trigger deliveries_guard;
  alter table payments.link_status_history disable trigger link_status_history_append_only;
  alter table payments.events disable trigger events_append_only;
  delete from payments.delivery_attempts; delete from payments.deliveries; delete from payments.link_status_history;
  delete from payments.events; delete from payments.payment_links; delete from payments.clients;
  alter table payments.delivery_attempts enable trigger delivery_attempts_append_only;
  alter table payments.deliveries enable trigger deliveries_guard;
  alter table payments.link_status_history enable trigger link_status_history_append_only;
  alter table payments.events enable trigger events_append_only;
  delete from public.payment_attempts; delete from public.payment_invoices; delete from public.billing_subscriptions;
end $$;

create or replace function pg_temp.triggers_on() returns boolean language sql as $$
  select (select count(*) from pg_trigger where tgname in ('delivery_attempts_append_only','deliveries_guard','link_status_history_append_only','events_append_only') and tgenabled = 'O') = 4
$$;

-- 1) base sin la factura: no hace nada
\i :mig
select pg_temp.ok('sin factura: no hace nada y no falla', true);

-- 2) escenario exacto => revierte
select pg_temp.scenario();
select pg_temp.ok('previo: la suscripcion sigue intacta tras el pago de prueba', (select status = 'ACTIVE' and current_period_end = '2026-11-10 05:00+00' and updated_at = '2026-10-13 19:50:00.969726+00' from public.billing_subscriptions));
\i :mig
select pg_temp.ok('exacto: factura de vuelta a PENDING', (select status = 'PENDING' from public.payment_invoices));
select pg_temp.ok('exacto: sin tx / metodo / datos / link en la factura', (select provider_transaction_id is null and provider_payment_method is null and provider_payment_data is null and payments_link_id is null from public.payment_invoices));
select pg_temp.ok('exacto: payment_attempts borrado', (select count(*) = 0 from public.payment_attempts));
select pg_temp.ok('exacto: la suscripcion NO cambio (estado, periodo ni updated_at)', (select status = 'ACTIVE' and current_period_start = '2026-10-10 05:00+00' and current_period_end = '2026-11-10 05:00+00' and updated_at = '2026-10-13 19:50:00.969726+00' from public.billing_subscriptions));
select pg_temp.ok('exacto: link del servicio borrado', (select count(*) = 0 from payments.payment_links));
select pg_temp.ok('exacto: historial, evento, entrega e intento borrados', (select (select count(*) from payments.link_status_history) + (select count(*) from payments.events) + (select count(*) from payments.deliveries) + (select count(*) from payments.delivery_attempts) = 0));
select pg_temp.ok('exacto: el cliente interno SE CONSERVA', (select count(*) = 1 from payments.clients where id = 'd01aaca8-4594-4f87-b5a2-4de093fc547e'));
select pg_temp.ok('exacto: triggers de proteccion vuelven a estar habilitados', pg_temp.triggers_on());
select pg_temp.ok('exacto: la factura puede volver a pagarse (el indice unico por transaccion quedo libre)', (select count(*) = 0 from public.payment_invoices where provider_transaction_id is not null));

-- 3) idempotente
\i :mig
select pg_temp.ok('idempotente: segunda corrida no hace nada', (select status = 'PENDING' from public.payment_invoices));
select pg_temp.reset();

-- 4) un payment_attempt extra => aborta, no borra nada
select pg_temp.scenario('sandbox', 3, true);
\i :mig
select pg_temp.ok('attempt extra: la factura sigue PAID', (select status = 'PAID' from public.payment_invoices));
select pg_temp.ok('attempt extra: el link sigue', (select count(*) = 1 from payments.payment_links));
select pg_temp.ok('attempt extra: triggers siguen habilitados', pg_temp.triggers_on());
select pg_temp.reset();

-- 5) historial distinto => aborta
select pg_temp.scenario('sandbox', 4);
\i :mig
select pg_temp.ok('historial distinto: no borra', (select count(*) = 1 from payments.payment_links));
select pg_temp.reset();

-- 6) link de produccion => aborta
select pg_temp.scenario('production', 3);
\i :mig
select pg_temp.ok('link de produccion: no borra', (select count(*) = 1 from payments.payment_links where environment = 'production'));
select pg_temp.reset();

-- 7) la suscripcion cambio despues de la prueba => aborta
select pg_temp.scenario();
update public.billing_subscriptions set updated_at = '2026-10-21 10:00+00';
\i :mig
select pg_temp.ok('suscripcion modificada: la factura sigue PAID', (select status = 'PAID' from public.payment_invoices));
select pg_temp.reset();

-- 8) otra transaccion en la factura => aborta
select pg_temp.scenario();
update public.payment_invoices set provider_transaction_id = 'otra-tx';
\i :mig
select pg_temp.ok('otra transaccion: no borra', (select count(*) = 1 from payments.payment_links));
select pg_temp.reset();

-- 9) las protecciones siguen vivas despues de la migracion
select pg_temp.scenario();
\i :mig
do $$ begin
  begin
    insert into payments.events (classification, raw) values ('malformed', '{}');
    delete from payments.events where classification = 'malformed';
    raise notice 'FAIL: el trigger solo-insertar no bloqueo el delete';
  exception when sqlstate 'PY423' then raise notice 'PASS solo-insertar sigue activo tras la migracion';
  end;
end $$;
