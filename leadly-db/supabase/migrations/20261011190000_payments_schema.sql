-- payments: API de links de pago para proyectos externos (P1 de
-- progress/feature_payments_api.md; contrato NORMATIVO en
-- progress/payments_interface_spec.md §0-§2).
--
-- Aislamiento: el esquema `payments` no tiene ninguna FK, vista, trigger ni
-- funcion que lea o escriba tablas de `public`. Referencias a usuarios son
-- uuid planos. La unica interaccion con `public` son los wrappers
-- `public.payments_*` (unica superficie, solo service_role) y el secreto de
-- Vault `cron_reminder_secret` que lee `payments_trigger_dispatch()` (mismo
-- patron que 20260902170000_task_reminders_cron.sql).
--
-- Prerrequisitos ya presentes en produccion (no se re-crean aqui): extensiones
-- pg_cron y pg_net (20260804000004), tabla public.internal_secrets y el
-- secreto 'cron_reminder_secret' (20260804000005).
--
-- Idempotente: if not exists / create or replace / drop trigger if exists.

-- ---------------------------------------------------------------------------
-- Esquema y privilegios
-- ---------------------------------------------------------------------------
create schema if not exists payments;

revoke all on schema payments from public, anon, authenticated;
grant usage on schema payments to service_role;

-- ---------------------------------------------------------------------------
-- Funciones de trigger (viven en payments; no tocan public)
-- ---------------------------------------------------------------------------
create or replace function payments.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Tablas de solo-insertar: bloquea UPDATE, DELETE y TRUNCATE.
create or replace function payments.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'payments.% es solo-insertar (% no permitido)', tg_table_name, tg_op
    using errcode = 'PY423';
end;
$$;

-- events: unica excepcion = redaccion de datos personales, que solo puede
-- cambiar `raw` y `raw_redacted_at` (de null a un valor) y solo dentro de
-- payments_redact_events (marca transaccional `payments.allow_redact`).
create or replace function payments.events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and coalesce(pg_catalog.current_setting('payments.allow_redact', true), '') = 'on'
     and old.raw_redacted_at is null
     and new.raw_redacted_at is not null
     and (to_jsonb(new) - 'raw' - 'raw_redacted_at')
         = (to_jsonb(old) - 'raw' - 'raw_redacted_at')
  then
    return new;
  end if;
  raise exception 'payments.events es solo-insertar (% no permitido)', tg_op
    using errcode = 'PY423';
end;
$$;

-- deliveries: el estado de entrega cambia, pero la identidad y el cuerpo
-- enviado (evidencia) son inmutables y la fila no se borra.
create or replace function payments.deliveries_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
       or new.event_id is distinct from old.event_id
       or new.client_id is distinct from old.client_id
       or new.link_id is distinct from old.link_id
       or new.url is distinct from old.url
       or new.body_sha256 is distinct from old.body_sha256
       or new.created_at is distinct from old.created_at
       or (new.body is distinct from old.body
           and not (coalesce(pg_catalog.current_setting('payments.allow_redact', true), '') = 'on'
                    and (new.body - 'wompi') = (old.body - 'wompi')))
    then
      raise exception 'payments.deliveries: columnas de evidencia inmutables'
        using errcode = 'PY423';
    end if;
    return new;
  end if;
  raise exception 'payments.deliveries no admite % ', tg_op using errcode = 'PY423';
end;
$$;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table if not exists payments.clients (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  status              text not null default 'active'
                        check (status in ('active', 'suspended')),
  api_key_hash        text not null,
  key_prefix          text not null,
  callback_url        text,
  signing_secret_name text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  revoked_at          timestamptz,
  created_by          uuid,
  constraint payments_clients_name_key unique (name),
  constraint payments_clients_api_key_hash_key unique (api_key_hash),
  constraint payments_clients_name_nonblank check (btrim(name) <> ''),
  constraint payments_clients_hash_format check (api_key_hash ~ '^[0-9a-f]{64}$'),
  constraint payments_clients_callback_https check (callback_url is null or callback_url ~ '^https://[^[:space:]]+$'),
  constraint payments_clients_secret_prefix check (signing_secret_name is null or signing_secret_name like 'payments/%')
);

create table if not exists payments.payment_links (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references payments.clients (id),
  wompi_link_id       text,
  external_reference  text not null,
  idempotency_key     text not null,
  request_hash        text not null,
  amount_in_cents     bigint not null check (amount_in_cents >= 1),
  currency            text not null,
  environment         text not null check (environment in ('sandbox', 'production')),
  name                text not null,
  description         text not null,
  redirect_url        text,
  expires_at          timestamptz,
  metadata            jsonb not null default '{}'::jsonb,
  status              text not null default 'creating'
                        check (status in ('creating', 'pending', 'paid', 'voided', 'expired', 'cancelled', 'error')),
  status_detail       text,
  checkout_url        text,
  paid_transaction_id text,
  paid_at             timestamptz,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint payments_links_wompi_link_id_key unique (wompi_link_id),
  constraint payments_links_idem_key unique (client_id, idempotency_key)
);

create index if not exists payments_links_client_created_idx
  on payments.payment_links (client_id, created_at desc, id desc);
create index if not exists payments_links_client_extref_idx
  on payments.payment_links (client_id, external_reference);
create index if not exists payments_links_status_created_idx
  on payments.payment_links (status, created_at desc);

create table if not exists payments.events (
  id                bigint generated always as identity primary key,
  received_at       timestamptz not null default now(),
  environment       text,
  wompi_link_id     text,
  link_id           uuid references payments.payment_links (id),
  transaction_id    text,
  tx_status         text,
  amount_in_cents   bigint,
  currency          text,
  sent_at           timestamptz,
  signature_valid   boolean,
  amount_matches    boolean,
  classification    text not null
                      check (classification in ('processed', 'duplicate', 'duplicate_payment', 'unknown_link',
                                                'invalid_signature', 'amount_mismatch', 'malformed',
                                                'forwarded_foreign', 'unverified', 'verification_mismatch',
                                                'transaction_conflict')),
  raw               jsonb not null,
  raw_redacted_at   timestamptz
);

create unique index if not exists payments_events_dedupe_idx
  on payments.events (transaction_id, tx_status, wompi_link_id)
  where classification in ('processed', 'duplicate_payment');
create index if not exists payments_events_link_idx
  on payments.events (link_id, id desc);
create index if not exists payments_events_received_idx
  on payments.events (received_at)
  where raw_redacted_at is null;

create table if not exists payments.link_status_history (
  id          bigint generated always as identity primary key,
  link_id     uuid not null references payments.payment_links (id),
  from_status text,
  to_status   text not null,
  cause       text not null,
  event_id    bigint references payments.events (id),
  created_at  timestamptz not null default now()
);

create index if not exists payments_history_link_idx
  on payments.link_status_history (link_id, id);

-- `body` (jsonb) es el sobre ya armado (§4) y se guarda tal cual se va a
-- firmar/enviar: reintentos y evidencia usan SIEMPRE el mismo cuerpo, aunque
-- el link cambie de estado despues. Columna agregada respecto al §1.
create table if not exists payments.deliveries (
  id               uuid primary key default gen_random_uuid(),
  event_id         bigint not null references payments.events (id),
  client_id        uuid not null references payments.clients (id),
  link_id          uuid not null references payments.payment_links (id),
  url              text not null,
  body             jsonb not null,
  body_sha256      text not null,
  attempt          int not null default 0,
  status           text not null default 'pending'
                     check (status in ('pending', 'delivered', 'failed')),
  next_attempt_at  timestamptz not null default now(),
  http_status      int,
  duration_ms      int,
  last_error       text,
  created_at       timestamptz not null default now(),
  delivered_at     timestamptz,
  constraint payments_deliveries_event_client_key unique (event_id, client_id)
);

create index if not exists payments_deliveries_due_idx
  on payments.deliveries (next_attempt_at)
  where status = 'pending';

create table if not exists payments.delivery_attempts (
  id           bigint generated always as identity primary key,
  delivery_id  uuid not null references payments.deliveries (id),
  attempt      int not null,
  http_status  int,
  duration_ms  int,
  error        text,
  sent_sha256  text,
  created_at   timestamptz not null default now()
);

-- Ronda 2: sha256 hex de los bytes EXACTOS enviados (lo informa P2).
alter table payments.delivery_attempts add column if not exists sent_sha256 text;

create index if not exists payments_attempts_delivery_idx
  on payments.delivery_attempts (delivery_id, id);

-- Si las tablas ya existian con la version anterior de los CHECK, se refrescan.
alter table payments.events drop constraint if exists events_classification_check;
alter table payments.events add constraint events_classification_check
  check (classification in ('processed', 'duplicate', 'duplicate_payment', 'unknown_link',
                            'invalid_signature', 'amount_mismatch', 'malformed',
                            'forwarded_foreign', 'unverified', 'verification_mismatch',
                            'transaction_conflict'));
alter table payments.payment_links drop constraint if exists payment_links_status_check;
alter table payments.payment_links add constraint payment_links_status_check
  check (status in ('creating', 'pending', 'paid', 'voided', 'expired', 'cancelled', 'error'));

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
drop trigger if exists clients_set_updated_at on payments.clients;
create trigger clients_set_updated_at before update on payments.clients
  for each row execute function payments.set_updated_at();

drop trigger if exists payment_links_set_updated_at on payments.payment_links;
create trigger payment_links_set_updated_at before update on payments.payment_links
  for each row execute function payments.set_updated_at();

drop trigger if exists link_status_history_append_only on payments.link_status_history;
create trigger link_status_history_append_only before update or delete on payments.link_status_history
  for each row execute function payments.forbid_mutation();
drop trigger if exists link_status_history_no_truncate on payments.link_status_history;
create trigger link_status_history_no_truncate before truncate on payments.link_status_history
  for each statement execute function payments.forbid_mutation();

drop trigger if exists delivery_attempts_append_only on payments.delivery_attempts;
create trigger delivery_attempts_append_only before update or delete on payments.delivery_attempts
  for each row execute function payments.forbid_mutation();
drop trigger if exists delivery_attempts_no_truncate on payments.delivery_attempts;
create trigger delivery_attempts_no_truncate before truncate on payments.delivery_attempts
  for each statement execute function payments.forbid_mutation();

drop trigger if exists events_append_only on payments.events;
create trigger events_append_only before update or delete on payments.events
  for each row execute function payments.events_guard();
drop trigger if exists events_no_truncate on payments.events;
create trigger events_no_truncate before truncate on payments.events
  for each statement execute function payments.forbid_mutation();

drop trigger if exists deliveries_guard on payments.deliveries;
create trigger deliveries_guard before update or delete on payments.deliveries
  for each row execute function payments.deliveries_guard();
drop trigger if exists deliveries_no_truncate on payments.deliveries;
create trigger deliveries_no_truncate before truncate on payments.deliveries
  for each statement execute function payments.forbid_mutation();

-- ---------------------------------------------------------------------------
-- RLS activada SIN policies + grants minimos solo a service_role
-- ---------------------------------------------------------------------------
alter table payments.clients             enable row level security;
alter table payments.payment_links       enable row level security;
alter table payments.events              enable row level security;
alter table payments.link_status_history enable row level security;
alter table payments.deliveries          enable row level security;
alter table payments.delivery_attempts   enable row level security;

revoke all on all tables in schema payments from public, anon, authenticated;
revoke all on all sequences in schema payments from public, anon, authenticated;
alter default privileges in schema payments revoke all on tables from anon, authenticated;
alter default privileges in schema payments revoke all on sequences from anon, authenticated;

grant select, insert, update on payments.clients, payments.payment_links, payments.deliveries to service_role;
grant select, insert on payments.events, payments.link_status_history, payments.delivery_attempts to service_role;
grant update (raw, raw_redacted_at) on payments.events to service_role;
grant usage, select on all sequences in schema payments to service_role;

-- ---------------------------------------------------------------------------
-- Funciones publicas (todas retornan jsonb salvo donde el contrato dice text)
-- ---------------------------------------------------------------------------

-- 1. lookup_client ---------------------------------------------------------
create or replace function public.payments_lookup_client(p_key_hash text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb;
begin
  select jsonb_build_object('id', c.id, 'name', c.name, 'status', c.status,
                            'callback_url', c.callback_url,
                            'signing_secret_name', c.signing_secret_name)
    into v
    from payments.clients c
   where c.api_key_hash = p_key_hash
     and c.status = 'active'
     and c.revoked_at is null;
  return v; -- null si no existe / suspendida / revocada
end;
$$;

-- 2. begin_link ------------------------------------------------------------
create or replace function public.payments_begin_link(
  p_client_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_request jsonb,
  p_environment text,
  p_created_by uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_client payments.clients%rowtype;
  v_link payments.payment_links%rowtype;
  v_amount bigint;
  v_currency text;
  v_name text;
  v_desc text;
  v_extref text;
  v_redirect text;
  v_expires timestamptz;
  v_meta jsonb;
  v_inserted boolean := false;
begin
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'idempotency_key invalida' using errcode = 'PY422';
  end if;
  if p_request_hash is null or btrim(p_request_hash) = '' then
    raise exception 'request_hash requerido' using errcode = 'PY422';
  end if;
  if p_environment is null or p_environment not in ('sandbox', 'production') then
    raise exception 'environment invalido' using errcode = 'PY422';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'request invalido' using errcode = 'PY422';
  end if;

  select * into v_client from payments.clients where id = p_client_id;
  if not found then
    raise exception 'proyecto no existe' using errcode = 'PY404';
  end if;
  if v_client.status <> 'active' or v_client.revoked_at is not null then
    raise exception 'proyecto no activo' using errcode = 'PY423';
  end if;

  -- Replay / conflicto de idempotencia ANTES de validar el cuerpo: una
  -- repeticion exacta siempre devuelve la fila original.
  select * into v_link from payments.payment_links
   where client_id = p_client_id and idempotency_key = p_idempotency_key;
  if found then
    if v_link.request_hash = p_request_hash then
      return jsonb_build_object('link', to_jsonb(v_link), 'replayed', true);
    end if;
    raise exception 'Idempotency-Key reutilizada con otro cuerpo' using errcode = 'PY409';
  end if;

  -- Validacion del cuerpo (defensa en profundidad; P2 valida primero).
  if jsonb_typeof(p_request -> 'amount_in_cents') is distinct from 'number'
     or (p_request ->> 'amount_in_cents') !~ '^[0-9]{1,15}$'
     or (p_request ->> 'amount_in_cents')::bigint < 1 then
    raise exception 'amount_in_cents debe ser entero >= 1' using errcode = 'PY422';
  end if;
  v_amount := (p_request ->> 'amount_in_cents')::bigint;
  v_currency := p_request ->> 'currency';
  if v_currency is distinct from 'COP' then
    raise exception 'solo se admite COP' using errcode = 'PY422';
  end if;
  v_name := p_request ->> 'name';
  v_desc := p_request ->> 'description';
  v_extref := p_request ->> 'external_reference';
  if v_name is null or btrim(v_name) = '' or v_desc is null or btrim(v_desc) = ''
     or v_extref is null or btrim(v_extref) = '' then
    raise exception 'name, description y external_reference son obligatorios' using errcode = 'PY422';
  end if;
  v_redirect := p_request ->> 'redirect_url';
  if v_redirect is not null and v_redirect !~ '^https://[^[:space:]]+$' then
    raise exception 'redirect_url debe ser https' using errcode = 'PY422';
  end if;
  begin
    v_expires := nullif(p_request ->> 'expires_at', '')::timestamptz;
  exception when others then
    raise exception 'expires_at invalido' using errcode = 'PY422';
  end;
  v_meta := coalesce(p_request -> 'metadata', '{}'::jsonb);
  if jsonb_typeof(v_meta) <> 'object' then
    raise exception 'metadata debe ser objeto' using errcode = 'PY422';
  end if;

  insert into payments.payment_links
    (client_id, external_reference, idempotency_key, request_hash, amount_in_cents, currency,
     environment, name, description, redirect_url, expires_at, metadata, status, created_by)
  values
    (p_client_id, v_extref, p_idempotency_key, p_request_hash, v_amount, v_currency,
     p_environment, v_name, v_desc, v_redirect, v_expires, v_meta, 'creating', p_created_by)
  on conflict (client_id, idempotency_key) do nothing
  returning * into v_link;
  v_inserted := found;

  if not v_inserted then
    -- Carrera: otra transaccion la inserto entre el select y el insert.
    select * into v_link from payments.payment_links
     where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if v_link.request_hash = p_request_hash then
      return jsonb_build_object('link', to_jsonb(v_link), 'replayed', true);
    end if;
    raise exception 'Idempotency-Key reutilizada con otro cuerpo' using errcode = 'PY409';
  end if;

  insert into payments.link_status_history (link_id, from_status, to_status, cause)
  values (v_link.id, null, 'creating', 'created');

  return jsonb_build_object('link', to_jsonb(v_link), 'replayed', false);
end;
$$;

-- 3. attach_wompi_link -----------------------------------------------------
create or replace function public.payments_attach_wompi_link(
  p_link_id uuid, p_wompi_link_id text, p_checkout_url text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_link payments.payment_links%rowtype;
begin
  if p_wompi_link_id is null or btrim(p_wompi_link_id) = '' then
    raise exception 'wompi_link_id requerido' using errcode = 'PY422';
  end if;
  select * into v_link from payments.payment_links where id = p_link_id for update;
  if not found then
    raise exception 'link no existe' using errcode = 'PY404';
  end if;
  if v_link.status = 'pending' and v_link.wompi_link_id = p_wompi_link_id then
    return to_jsonb(v_link); -- reintento idempotente
  end if;
  if v_link.status <> 'creating' then
    raise exception 'el link no esta en creating (esta en %)', v_link.status using errcode = 'PY423';
  end if;
  begin
    update payments.payment_links
       set wompi_link_id = p_wompi_link_id, checkout_url = p_checkout_url, status = 'pending'
     where id = p_link_id
     returning * into v_link;
  exception when unique_violation then
    raise exception 'wompi_link_id ya asociado a otro link' using errcode = 'PY409';
  end;
  insert into payments.link_status_history (link_id, from_status, to_status, cause)
  values (v_link.id, 'creating', 'pending', 'wompi_link_created');
  return to_jsonb(v_link);
end;
$$;

-- 4. fail_link -------------------------------------------------------------
create or replace function public.payments_fail_link(p_link_id uuid, p_detail text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_link payments.payment_links%rowtype;
begin
  select * into v_link from payments.payment_links where id = p_link_id for update;
  if not found then
    raise exception 'link no existe' using errcode = 'PY404';
  end if;
  if v_link.status = 'error' then
    return to_jsonb(v_link);
  end if;
  if v_link.status <> 'creating' then
    raise exception 'el link no esta en creating (esta en %)', v_link.status using errcode = 'PY423';
  end if;
  update payments.payment_links
     set status = 'error', status_detail = left(coalesce(p_detail, ''), 500)
   where id = p_link_id
   returning * into v_link;
  insert into payments.link_status_history (link_id, from_status, to_status, cause)
  values (v_link.id, 'creating', 'error', 'wompi_create_failed');
  return to_jsonb(v_link);
end;
$$;

-- 14. find_link_by_wompi_id (spec §6 item 14) -----------------------------
create or replace function public.payments_find_link_by_wompi_id(p_wompi_link_id text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v jsonb;
begin
  if p_wompi_link_id is null or btrim(p_wompi_link_id) = '' then
    return null;
  end if;
  select jsonb_build_object('id', l.id, 'client_id', l.client_id, 'environment', l.environment,
                            'status', l.status, 'amount_in_cents', l.amount_in_cents,
                            'currency', l.currency)
    into v
    from payments.payment_links l
   where l.wompi_link_id = p_wompi_link_id;
  return v;
end;
$$;

-- 5. get_link --------------------------------------------------------------
-- Incluye `last_event` { id, classification, transaction_id, tx_status,
-- amount_in_cents, received_at } (null si no hay eventos) -- spec §6 item 17.
create or replace function public.payments_get_link(
  p_client_id uuid, p_id uuid, p_external_reference text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_link payments.payment_links%rowtype;
  v_last jsonb;
begin
  if p_client_id is null or (p_id is null and p_external_reference is null) then
    raise exception 'client_id y (id | external_reference) requeridos' using errcode = 'PY422';
  end if;
  if p_id is not null then
    select * into v_link from payments.payment_links
     where client_id = p_client_id and id = p_id;
  else
    select * into v_link from payments.payment_links
     where client_id = p_client_id and external_reference = p_external_reference
     order by created_at desc, id desc limit 1;
  end if;
  if not found then
    raise exception 'link no existe' using errcode = 'PY404';
  end if;
  select jsonb_build_object('id', e.id, 'classification', e.classification,
                            'transaction_id', e.transaction_id, 'tx_status', e.tx_status,
                            'amount_in_cents', e.amount_in_cents, 'received_at', e.received_at)
    into v_last
    from payments.events e
   where e.link_id = v_link.id
   order by e.id desc limit 1;
  return to_jsonb(v_link) || jsonb_build_object('last_event', v_last);
end;
$$;

-- 6. list_links ------------------------------------------------------------
create or replace function public.payments_list_links(
  p_client_id uuid, p_status text, p_limit int, p_before timestamptz
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_items jsonb;
  v_count int;
  v_next timestamptz;
begin
  with page as (
    select l.*, c.name as client_name
      from payments.payment_links l
      join payments.clients c on c.id = l.client_id
     where (p_client_id is null or l.client_id = p_client_id)
       and (p_status is null or l.status = p_status)
       and (p_before is null or l.created_at < p_before)
     order by l.created_at desc, l.id desc
     limit v_limit
  )
  select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc, page.id desc), '[]'::jsonb),
         count(*)::int,
         min(page.created_at)
    into v_items, v_count, v_next
    from page;
  return jsonb_build_object('items', v_items,
                            'next_before', case when v_count >= v_limit then v_next else null end);
end;
$$;

-- 7. record_event ----------------------------------------------------------
-- Ronda 2: nueva firma (p_verified). Se elimina la anterior de 3 argumentos.
drop function if exists public.payments_record_event(jsonb, text, boolean);

-- p_verified = `data` de GET /transactions/{id} de Wompi (llave privada),
-- {"_not_found": true} si Wompi respondio 404, o null si no se pudo consultar.
create or replace function public.payments_record_event(
  p_payload jsonb, p_environment text, p_signature_valid boolean,
  p_verified jsonb default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_tx jsonb;
  v_tx_id text;
  v_status text;
  v_amount bigint;
  v_currency text;
  v_wlink text;
  v_sent timestamptz;
  v_env text;
  v_raw jsonb := coalesce(p_payload, 'null'::jsonb);
  v_link payments.payment_links%rowtype;
  v_client payments.clients%rowtype;
  v_found boolean := false;
  v_class text;
  v_amount_ok boolean;
  v_sig_ok boolean := coalesce(p_signature_valid, false);
  v_event_id bigint;
  v_event_at timestamptz;
  v_deliveries jsonb := '[]'::jsonb;
  v_body jsonb;
  v_did uuid;
  v_first_paid boolean := false;
  v_prev_status text;
  v_event jsonb;
  v_voided boolean := false;
begin
  -- Normalizacion de campos (todo defensivo: el evento siempre se registra).
  if jsonb_typeof(v_raw) = 'object' then
    v_tx := v_raw #> '{data,transaction}';
    v_env := case lower(coalesce(v_raw ->> 'environment', p_environment))
               when 'test' then 'sandbox' when 'sandbox' then 'sandbox'
               when 'prod' then 'production' when 'production' then 'production'
               else null end;
    begin
      v_sent := nullif(v_raw ->> 'sent_at', '')::timestamptz;
    exception when others then
      v_sent := null;
    end;
  else
    v_env := case lower(coalesce(p_environment, ''))
               when 'test' then 'sandbox' when 'sandbox' then 'sandbox'
               when 'prod' then 'production' when 'production' then 'production'
               else null end;
  end if;

  if v_tx is not null and jsonb_typeof(v_tx) = 'object' then
    v_tx_id := nullif(btrim(v_tx ->> 'id'), '');
    v_status := nullif(btrim(v_tx ->> 'status'), '');
    v_wlink := nullif(btrim(v_tx ->> 'payment_link_id'), '');
    v_currency := nullif(btrim(v_tx ->> 'currency'), '');
    if jsonb_typeof(v_tx -> 'amount_in_cents') = 'number'
       and (v_tx ->> 'amount_in_cents') ~ '^[0-9]{1,15}$' then
      v_amount := (v_tx ->> 'amount_in_cents')::bigint;
    end if;
  end if;

  if v_tx is null or jsonb_typeof(v_tx) <> 'object' or v_tx_id is null or v_status is null then
    v_class := 'malformed';
  elsif v_wlink is not null then
    -- Lock por link: serializa eventos concurrentes del mismo link.
    select * into v_link from payments.payment_links
     where wompi_link_id = v_wlink and (v_env is null or environment = v_env)
     for update;
    v_found := found;
  end if;

  if v_class is null then
    if p_signature_valid is null and not v_found then
      -- Evento AJENO reenviado por el receptor (spec §6 item 15b): se guarda
      -- sin procesar; la firma no se verifica aqui.
      v_class := 'forwarded_foreign';
    elsif not v_sig_ok then
      v_class := 'invalid_signature';
    elsif not v_found then
      v_class := 'unknown_link';
    elsif exists (select 1 from payments.events e
                   where e.transaction_id = v_tx_id
                     and e.wompi_link_id is distinct from v_wlink
                     and e.classification in ('processed', 'duplicate_payment', 'amount_mismatch',
                                              'forwarded_foreign')) then
      -- La misma transaccion ya vive bajo OTRO link: el checksum de Wompi no
      -- cubre payment_link_id, asi que esto es un replay cruzado (B1).
      v_class := 'transaction_conflict';
    elsif exists (select 1 from payments.events e
                   where e.transaction_id = v_tx_id and e.tx_status = v_status
                     and e.wompi_link_id = v_wlink
                     and e.classification in ('processed', 'duplicate_payment', 'amount_mismatch')) then
      v_class := 'duplicate';
    elsif v_amount is distinct from v_link.amount_in_cents
          or v_currency is distinct from v_link.currency then
      v_class := 'amount_mismatch';
    elsif v_status = 'APPROVED' then
      if p_verified is null or jsonb_typeof(p_verified) <> 'object' then
        -- Sin verificacion contra Wompi no se paga; NO consume la dedupe
        -- ('unverified' no esta en las clases del chequeo de arriba).
        v_class := 'unverified';
      elsif coalesce(p_verified ->> '_not_found', '') = 'true'
            or p_verified ->> 'id' is distinct from v_tx_id
            or p_verified ->> 'payment_link_id' is distinct from v_wlink
            or p_verified ->> 'status' is distinct from v_status
            or (case when jsonb_typeof(p_verified -> 'amount_in_cents') = 'number'
                          and (p_verified ->> 'amount_in_cents') ~ '^[0-9]{1,15}$'
                     then (p_verified ->> 'amount_in_cents')::bigint end) is distinct from v_amount
            or p_verified ->> 'currency' is distinct from v_currency then
        v_class := 'verification_mismatch';
      elsif v_link.status in ('paid', 'voided') then
        v_class := 'duplicate_payment';
      else
        v_class := 'processed';
        v_first_paid := true;
      end if;
    else
      v_class := 'processed';
      -- VOIDED de la transaccion que pago el link: el link pasa a voided.
      if v_status = 'VOIDED' and v_link.status = 'paid' and v_link.paid_transaction_id = v_tx_id then
        v_voided := true;
      end if;
    end if;
  end if;

  if v_found then
    v_amount_ok := not (v_amount is distinct from v_link.amount_in_cents
                        or v_currency is distinct from v_link.currency);
  end if;

  insert into payments.events
    (environment, wompi_link_id, link_id, transaction_id, tx_status, amount_in_cents, currency,
     sent_at, signature_valid, amount_matches, classification, raw)
  values
    (v_env, v_wlink, case when v_found then v_link.id end, v_tx_id, v_status, v_amount, v_currency,
     v_sent, p_signature_valid, v_amount_ok, v_class, v_raw)
  returning id, received_at into v_event_id, v_event_at;

  if v_first_paid then
    v_prev_status := v_link.status;
    update payments.payment_links
       set status = 'paid', paid_transaction_id = v_tx_id, paid_at = v_event_at,
           status_detail = null
     where id = v_link.id
     returning * into v_link;
    insert into payments.link_status_history (link_id, from_status, to_status, cause, event_id)
    values (v_link.id, v_prev_status, 'paid', 'wompi_approved', v_event_id);
  end if;

  if v_voided then
    update payments.payment_links set status = 'voided' where id = v_link.id
     returning * into v_link;
    insert into payments.link_status_history (link_id, from_status, to_status, cause, event_id)
    values (v_link.id, 'paid', 'voided', 'transaction_voided', v_event_id);
  end if;

  -- Aviso al proyecto (solo clasificaciones que le importan).
  if v_found and v_class in ('processed', 'duplicate_payment', 'amount_mismatch') then
    select * into v_client from payments.clients where id = v_link.client_id;
    if v_client.callback_url is not null then
      v_body := jsonb_build_object(
        'id', v_event_id::text,
        'type', 'payment_link.transaction',
        'created_at', to_char(v_event_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'payment_link', jsonb_build_object(
          'id', v_link.id,
          'external_reference', v_link.external_reference,
          'status', v_link.status,
          'amount_in_cents', v_link.amount_in_cents,
          'currency', v_link.currency,
          'metadata', v_link.metadata),
        'classification', v_class,
        'transaction', jsonb_build_object(
          'id', v_tx_id, 'status', v_status, 'amount_in_cents', v_amount, 'currency', v_currency),
        'wompi', v_raw);
      insert into payments.deliveries
        (event_id, client_id, link_id, url, body, body_sha256)
      values
        (v_event_id, v_client.id, v_link.id, v_client.callback_url, v_body,
         encode(sha256(convert_to(v_body::text, 'UTF8')), 'hex'))
      on conflict (event_id, client_id) do nothing
      returning id into v_did;
      if v_did is not null then
        v_deliveries := jsonb_build_array(jsonb_build_object('id', v_did, 'url', v_client.callback_url));
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'event_id', v_event_id,
    'classification', v_class,
    'link_id', case when v_found then v_link.id end,
    'client_id', case when v_found then v_link.client_id end,
    'link_status', case when v_found then v_link.status end,
    'deliveries', v_deliveries);
end;
$$;

-- 8. claim_deliveries ------------------------------------------------------
-- Lease de 2 minutos: si el worker muere, la entrega vuelve a estar disponible.
create or replace function public.payments_claim_deliveries(p_limit int)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_out jsonb;
begin
  with c as (
    select d.id
      from payments.deliveries d
     where d.status = 'pending' and d.next_attempt_at <= now()
       and exists (select 1 from payments.clients k
                    where k.id = d.client_id and k.status = 'active' and k.revoked_at is null)
     order by d.next_attempt_at, d.created_at
     limit least(greatest(coalesce(p_limit, 10), 1), 100)
     for update skip locked
  ), u as (
    update payments.deliveries d
       set next_attempt_at = now() + interval '2 minutes'
      from c, payments.clients cl
     where d.id = c.id and cl.id = d.client_id
    returning d.id, d.url, d.client_id, cl.signing_secret_name, d.body, d.attempt
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'delivery_id', u.id, 'url', u.url, 'client_id', u.client_id,
           'signing_secret_name', u.signing_secret_name, 'body', u.body,
           'attempt', u.attempt + 1)), '[]'::jsonb)
    into v_out
    from u;
  return v_out;
end;
$$;

-- (payments_claim_delivery se elimino en la ronda 2: P2 no la usa.)
drop function if exists public.payments_claim_delivery(uuid);

-- 9. complete_delivery -----------------------------------------------------
drop function if exists public.payments_complete_delivery(uuid, int, int, text);

-- p_sent_sha256: sha256 hex de los bytes exactos enviados (P2). deliveries.body_sha256
-- es el hash de body::text (representacion jsonb), NO de los bytes enviados.
create or replace function public.payments_complete_delivery(
  p_delivery_id uuid, p_http_status int, p_duration_ms int, p_error text,
  p_sent_sha256 text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_d payments.deliveries%rowtype;
  v_attempt int;
  v_status text;
  v_next timestamptz;
  v_delays interval[] := array[interval '1 minute', interval '5 minutes', interval '30 minutes',
                               interval '2 hours', interval '6 hours', interval '24 hours'];
  v_err text := left(p_error, 500);
begin
  select * into v_d from payments.deliveries where id = p_delivery_id for update;
  if not found then
    raise exception 'entrega no existe' using errcode = 'PY404';
  end if;
  v_attempt := v_d.attempt + 1;

  insert into payments.delivery_attempts (delivery_id, attempt, http_status, duration_ms, error, sent_sha256)
  values (v_d.id, v_attempt, p_http_status, p_duration_ms, v_err, left(p_sent_sha256, 64));

  if v_d.status = 'delivered' then
    update payments.deliveries set attempt = v_attempt where id = v_d.id;
    return jsonb_build_object('status', 'delivered', 'next_attempt_at', null);
  end if;

  -- p_http_status = 0 / null = sin respuesta HTTP (timeout, red, destino rechazado): fallo.
  if p_http_status between 200 and 299 then
    update payments.deliveries
       set status = 'delivered', attempt = v_attempt, http_status = p_http_status,
           duration_ms = p_duration_ms, last_error = null, delivered_at = now()
     where id = v_d.id;
    return jsonb_build_object('status', 'delivered', 'next_attempt_at', null);
  end if;

  if v_attempt >= 7 then
    update payments.deliveries
       set status = 'failed', attempt = v_attempt, http_status = p_http_status,
           duration_ms = p_duration_ms,
           last_error = coalesce(v_err, case when coalesce(p_http_status, 0) = 0 then 'sin respuesta HTTP'
                                             else 'http ' || p_http_status::text end)
     where id = v_d.id;
    return jsonb_build_object('status', 'failed', 'next_attempt_at', null);
  end if;

  v_next := now() + v_delays[v_attempt];
  update payments.deliveries
     set status = 'pending', attempt = v_attempt, http_status = p_http_status,
         duration_ms = p_duration_ms, next_attempt_at = v_next,
         last_error = coalesce(v_err, case when coalesce(p_http_status, 0) = 0 then 'sin respuesta HTTP'
                                           else 'http ' || p_http_status::text end)
   where id = v_d.id;
  return jsonb_build_object('status', 'pending', 'next_attempt_at', v_next);
end;
$$;

-- 10-11. administracion de proyectos --------------------------------------
create or replace function public.payments_admin_create_client(
  p_name text, p_callback_url text, p_key_hash text, p_key_prefix text,
  p_signing_secret_name text, p_created_by uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v payments.clients%rowtype;
begin
  if p_name is null or btrim(p_name) = '' then
    raise exception 'name requerido' using errcode = 'PY422';
  end if;
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' or p_key_prefix is null or btrim(p_key_prefix) = '' then
    raise exception 'key_hash/key_prefix invalidos' using errcode = 'PY422';
  end if;
  if p_callback_url is not null and p_callback_url !~ '^https://[^[:space:]]+$' then
    raise exception 'callback_url debe ser https' using errcode = 'PY422';
  end if;
  if p_signing_secret_name is not null and p_signing_secret_name not like 'payments/%' then
    raise exception 'signing_secret_name debe empezar por payments/' using errcode = 'PY422';
  end if;
  begin
    insert into payments.clients (name, callback_url, api_key_hash, key_prefix, signing_secret_name, created_by)
    values (btrim(p_name), p_callback_url, p_key_hash, p_key_prefix, p_signing_secret_name, p_created_by)
    returning * into v;
  exception when unique_violation then
    raise exception 'nombre o clave ya existen' using errcode = 'PY409';
  end;
  return to_jsonb(v) - 'api_key_hash';
end;
$$;

create or replace function public.payments_admin_list_clients()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg((to_jsonb(c) - 'api_key_hash') order by c.created_at desc, c.id), '[]'::jsonb)
    from payments.clients c;
$$;

create or replace function public.payments_admin_set_client_status(p_id uuid, p_status text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v payments.clients%rowtype;
begin
  if p_status is null or p_status not in ('active', 'suspended') then
    raise exception 'status invalido' using errcode = 'PY422';
  end if;
  update payments.clients set status = p_status where id = p_id returning * into v;
  if not found then
    raise exception 'proyecto no existe' using errcode = 'PY404';
  end if;
  return to_jsonb(v) - 'api_key_hash';
end;
$$;

create or replace function public.payments_admin_rotate_key(p_id uuid, p_key_hash text, p_key_prefix text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v payments.clients%rowtype;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' or p_key_prefix is null or btrim(p_key_prefix) = '' then
    raise exception 'key_hash/key_prefix invalidos' using errcode = 'PY422';
  end if;
  begin
    update payments.clients set api_key_hash = p_key_hash, key_prefix = p_key_prefix
     where id = p_id returning * into v;
  exception when unique_violation then
    raise exception 'clave ya existe' using errcode = 'PY409';
  end;
  if not found then
    raise exception 'proyecto no existe' using errcode = 'PY404';
  end if;
  return to_jsonb(v) - 'api_key_hash';
end;
$$;

create or replace function public.payments_admin_set_callback(
  p_id uuid, p_callback_url text, p_signing_secret_name text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v payments.clients%rowtype;
begin
  if p_callback_url is not null and p_callback_url !~ '^https://[^[:space:]]+$' then
    raise exception 'callback_url debe ser https' using errcode = 'PY422';
  end if;
  if p_signing_secret_name is not null and p_signing_secret_name not like 'payments/%' then
    raise exception 'signing_secret_name debe empezar por payments/' using errcode = 'PY422';
  end if;
  update payments.clients
     set callback_url = p_callback_url, signing_secret_name = p_signing_secret_name
   where id = p_id returning * into v;
  if not found then
    raise exception 'proyecto no existe' using errcode = 'PY404';
  end if;
  return to_jsonb(v) - 'api_key_hash';
end;
$$;

-- 12. redact_events --------------------------------------------------------
-- Quita datos personales del pagador del cuerpo crudo (events.raw y el
-- fragmento `wompi` del sobre guardado en deliveries.body). NUNCA borra filas
-- ni los campos resumen.
create or replace function public.payments_redact_events(p_older_than interval default interval '90 days')
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_n int;
begin
  if p_older_than is null or p_older_than < interval '1 day' then
    raise exception 'p_older_than minimo 1 dia' using errcode = 'PY422';
  end if;

  perform pg_catalog.set_config('payments.allow_redact', 'on', true);

  with red as (
    update payments.events e
       set raw_redacted_at = now(),
           raw = case
             when jsonb_typeof(e.raw) <> 'object' then e.raw
             when e.raw #> '{data,transaction,payment_method}' is null then
               e.raw #- '{data,transaction,customer_email}'
                     #- '{data,transaction,customer_data}'
                     #- '{data,transaction,shipping_address}'
                     #- '{data,transaction,payment_link,customer_data}'
                     #- '{data,customer_data}'
                     #- '{data,customer_email}'
                     #- '{data,shipping_address}'
             else
               -- payment_method se reduce a su tipo (extra trae banco, tarjeta, telefono)
               jsonb_set(
                 e.raw #- '{data,transaction,customer_email}'
                       #- '{data,transaction,customer_data}'
                       #- '{data,transaction,shipping_address}'
                       #- '{data,transaction,payment_link,customer_data}'
                       #- '{data,customer_data}'
                       #- '{data,customer_email}'
                       #- '{data,shipping_address}',
                 '{data,transaction,payment_method}',
                 jsonb_build_object('type', e.raw #> '{data,transaction,payment_method,type}'),
                 false)
             end
     where e.raw_redacted_at is null
       and e.received_at < now() - p_older_than
    returning e.id, e.raw
  ), dl as (
    update payments.deliveries d
       set body = jsonb_set(d.body, '{wompi}', red.raw, true)
      from red
     where d.event_id = red.id
    returning d.id
  )
  select count(*)::int into v_n from red;

  return jsonb_build_object('redacted', v_n);
end;
$$;

-- 15. health_summary (ronda 2) ----------------------------------------------
create or replace function public.payments_health_summary(p_hours int default 24)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_since timestamptz := now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 8760));
  v jsonb;
begin
  select jsonb_build_object(
    'invalid_signature',       count(*) filter (where e.classification = 'invalid_signature'),
    'unverified',              count(*) filter (where e.classification = 'unverified'),
    'verification_mismatch',   count(*) filter (where e.classification = 'verification_mismatch'),
    'transaction_conflict',    count(*) filter (where e.classification = 'transaction_conflict'),
    'amount_mismatch',         count(*) filter (where e.classification = 'amount_mismatch'),
    'duplicate_payment',       count(*) filter (where e.classification = 'duplicate_payment'))
    into v
    from payments.events e
   where e.received_at >= v_since;

  return v || jsonb_build_object(
    'deliveries_failed', (select count(*) from payments.deliveries d
                           where d.status = 'failed' and d.created_at >= v_since),
    'stale_pending_links', (select count(*) from payments.payment_links l
                             where l.status = 'pending' and l.created_at < now() - interval '24 hours'
                               and exists (select 1 from payments.events e
                                            where e.link_id = l.id
                                              and e.classification in ('unverified', 'invalid_signature'))));
end;
$$;

-- 13. secretos (Vault) -----------------------------------------------------
create or replace function public.payments_read_signing_secret_name(p_client_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v text;
begin
  select signing_secret_name into v from payments.clients where id = p_client_id;
  if not found then
    raise exception 'proyecto no existe' using errcode = 'PY404';
  end if;
  if v is null or v not like 'payments/%' then
    return null;
  end if;
  return v;
end;
$$;

-- security definer: vault.* no es accesible para service_role directamente.
create or replace function public.payments_store_secret(p_name text, p_value text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_name is null or p_name !~ '^payments/[A-Za-z0-9._:/-]{1,200}$' then
    raise exception 'nombre de secreto invalido (prefijo payments/)' using errcode = 'PY422';
  end if;
  if p_value is null or p_value = '' then
    raise exception 'valor requerido' using errcode = 'PY422';
  end if;
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    perform vault.create_secret(p_value, p_name, 'payments');
  else
    perform vault.update_secret(v_id, p_value);
  end if;
  return jsonb_build_object('name', p_name);
end;
$$;

create or replace function public.payments_read_secret(p_name text)
returns text
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v text;
begin
  if p_name is null or p_name !~ '^payments/[A-Za-z0-9._:/-]{1,200}$' then
    raise exception 'nombre de secreto invalido (prefijo payments/)' using errcode = 'PY422';
  end if;
  select decrypted_secret into v from vault.decrypted_secrets where name = p_name;
  if v is null then
    raise exception 'secreto no existe' using errcode = 'PY404';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cron: dispatch cada minuto + redaccion diaria
-- ---------------------------------------------------------------------------
-- Mismo patron que public.trigger_task_reminders(): secreto compartido
-- 'cron_reminder_secret' leido de Vault via public.internal_secrets; ni el
-- secreto ni ninguna llave viven en este archivo. La URL del proyecto no es
-- secreta (mismo valor hardcodeado que los otros crons).
create or replace function public.payments_trigger_dispatch()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_key text;
begin
  -- Sin entregas vencidas no se invoca la Edge Function (evita 1440 llamadas/dia vacias).
  if not exists (select 1 from payments.deliveries d
                  join payments.clients k on k.id = d.client_id and k.status = 'active' and k.revoked_at is null
                  where d.status = 'pending' and d.next_attempt_at <= now()) then
    return;
  end if;

  select secret_id into v_secret_id from public.internal_secrets where key = 'cron_reminder_secret';
  if v_secret_id is null then
    return;
  end if;

  select decrypted_secret into v_key from vault.decrypted_secrets where id = v_secret_id;
  if v_key is null then
    return;
  end if;

  perform net.http_post(
    url := 'https://kkdtrkfcnyvuefazndnj.supabase.co/functions/v1/payments-api/internal/dispatch',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'payments-dispatch') then
    perform cron.unschedule('payments-dispatch');
  end if;
  perform cron.schedule('payments-dispatch', '* * * * *', 'select public.payments_trigger_dispatch();');

  if exists (select 1 from cron.job where jobname = 'payments-redact-events') then
    perform cron.unschedule('payments-redact-events');
  end if;
  perform cron.schedule('payments-redact-events', '30 8 * * *', 'select public.payments_redact_events();');
end;
$$;

-- ---------------------------------------------------------------------------
-- Revoke/grant de TODAS las funciones payments_* (las nuevas heredan EXECUTE
-- para PUBLIC y para anon/authenticated por default privileges de Supabase).
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'payments\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end;
$$;
