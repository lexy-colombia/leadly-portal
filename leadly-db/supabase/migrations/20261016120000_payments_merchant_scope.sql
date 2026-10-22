-- Comercio (merchant) en el servicio de pagos. ADITIVA salvo el reemplazo de dos firmas.
--  * payments.payment_links.merchant_tenant_id: tenant dueno de la credencial Wompi con la que
--    se cobra el link (null = cuenta de plataforma). Sin FK a public (aislamiento del esquema).
--  * payments.clients.kind: 'external' (default) | 'internal'. Solo 'internal' puede fijar comercio.
--  * payments_begin_link gana p_merchant_tenant_id (default null); se elimina la firma de 6 args.
--  * payments_admin_create_client gana p_kind (default 'external'); se elimina la firma de 6 args.
--  * payments_lookup_client devuelve kind; payments_find_link_by_wompi_id devuelve merchant_tenant_id.

alter table payments.payment_links add column if not exists merchant_tenant_id uuid;

alter table payments.clients add column if not exists kind text not null default 'external';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_clients_kind_check') then
    alter table payments.clients
      add constraint payments_clients_kind_check check (kind in ('external', 'internal'));
  end if;
end;
$$;

create index if not exists payments_links_merchant_idx
  on payments.payment_links (merchant_tenant_id) where merchant_tenant_id is not null;

-- lookup_client ------------------------------------------------------------
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
                            'signing_secret_name', c.signing_secret_name,
                            'kind', c.kind)
    into v
    from payments.clients c
   where c.api_key_hash = p_key_hash
     and c.status = 'active'
     and c.revoked_at is null;
  return v; -- null si no existe / suspendida / revocada
end;
$$;

-- begin_link ---------------------------------------------------------------
drop function if exists public.payments_begin_link(uuid, text, text, jsonb, text, uuid);

create or replace function public.payments_begin_link(
  p_client_id uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_request jsonb,
  p_environment text,
  p_created_by uuid,
  p_merchant_tenant_id uuid default null
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
  -- Solo un cliente interno puede cobrar a nombre de un comercio (tenant).
  if p_merchant_tenant_id is not null and v_client.kind <> 'internal' then
    raise exception 'el proyecto no puede fijar un comercio' using errcode = 'PY424';
  end if;

  -- Replay / conflicto de idempotencia ANTES de validar el cuerpo: una
  -- repeticion exacta siempre devuelve la fila original.
  select * into v_link from payments.payment_links
   where client_id = p_client_id and idempotency_key = p_idempotency_key;
  if found then
    if v_link.request_hash = p_request_hash
       and v_link.merchant_tenant_id is not distinct from p_merchant_tenant_id then
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
     environment, name, description, redirect_url, expires_at, metadata, status, created_by,
     merchant_tenant_id)
  values
    (p_client_id, v_extref, p_idempotency_key, p_request_hash, v_amount, v_currency,
     p_environment, v_name, v_desc, v_redirect, v_expires, v_meta, 'creating', p_created_by,
     p_merchant_tenant_id)
  on conflict (client_id, idempotency_key) do nothing
  returning * into v_link;
  v_inserted := found;

  if not v_inserted then
    -- Carrera: otra transaccion la inserto entre el select y el insert.
    select * into v_link from payments.payment_links
     where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if v_link.request_hash = p_request_hash
       and v_link.merchant_tenant_id is not distinct from p_merchant_tenant_id then
      return jsonb_build_object('link', to_jsonb(v_link), 'replayed', true);
    end if;
    raise exception 'Idempotency-Key reutilizada con otro cuerpo' using errcode = 'PY409';
  end if;

  insert into payments.link_status_history (link_id, from_status, to_status, cause)
  values (v_link.id, null, 'creating', 'created');

  return jsonb_build_object('link', to_jsonb(v_link), 'replayed', false);
end;
$$;

-- find_link_by_wompi_id ----------------------------------------------------
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
                            'currency', l.currency, 'merchant_tenant_id', l.merchant_tenant_id)
    into v
    from payments.payment_links l
   where l.wompi_link_id = p_wompi_link_id;
  return v;
end;
$$;

-- admin_create_client ------------------------------------------------------
drop function if exists public.payments_admin_create_client(text, text, text, text, text, uuid);

create or replace function public.payments_admin_create_client(
  p_name text, p_callback_url text, p_key_hash text, p_key_prefix text,
  p_signing_secret_name text, p_created_by uuid, p_kind text default 'external'
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
  if p_kind is null or p_kind not in ('external', 'internal') then
    raise exception 'kind debe ser external o internal' using errcode = 'PY422';
  end if;
  begin
    insert into payments.clients (name, callback_url, api_key_hash, key_prefix, signing_secret_name, created_by, kind)
    values (btrim(p_name), p_callback_url, p_key_hash, p_key_prefix, p_signing_secret_name, p_created_by, p_kind)
    returning * into v;
  exception when unique_violation then
    raise exception 'nombre o clave ya existen' using errcode = 'PY409';
  end;
  return to_jsonb(v) - 'api_key_hash';
end;
$$;

-- Revoke/grant de las funciones payments_* (solo service_role), igual que la migracion base.
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
