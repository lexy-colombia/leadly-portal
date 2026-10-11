-- payments: UNA sola bandeja de eventos de Wompi (fusion de payment-webhook-wompi
-- en payments-api; progress/webhook_merge_report.md).
--
-- payments-api pasa a ser el UNICO receptor de eventos de Wompi. Ademas de los
-- links del servicio nuevo (payments.payment_links), el receptor resuelve el
-- evento contra public.payment_invoices (cobro de Lexy a un tenant) y
-- public.sales_order_payment_links (un tenant cobrando a su cliente). Esas
-- tablas siguen siendo su propio registro de auditoria (payment_attempts /
-- sales_order_payments); aqui solo se agrega el evento CRUDO a payments.events
-- con una clasificacion propia, para que haya una bandeja unica de trazabilidad.
--
-- Aislamiento (spec §0): nada de esto lee ni escribe tablas de `public`; la
-- aplicacion del pago a las tablas legacy la hace la Edge Function.
--
-- Idempotente: add column if not exists / drop+add constraint / create or
-- replace / create index if not exists. NO edita 20261011190000 (ya aplicada).

-- 1. Origen del evento + nuevas clasificaciones --------------------------------
alter table payments.events add column if not exists origin text;
alter table payments.events add column if not exists origin_ref text;

alter table payments.events drop constraint if exists events_origin_check;
alter table payments.events add constraint events_origin_check
  check (origin is null or origin in ('legacy_invoice', 'legacy_order'));

alter table payments.events drop constraint if exists events_classification_check;
alter table payments.events add constraint events_classification_check
  check (classification in ('processed', 'duplicate', 'duplicate_payment', 'unknown_link',
                            'invalid_signature', 'amount_mismatch', 'malformed',
                            'forwarded_foreign', 'unverified', 'verification_mismatch',
                            'transaction_conflict',
                            -- fusion del webhook viejo: evento aplicado a una factura de
                            -- plataforma / a un pago de pedido de un tenant, y evento
                            -- aprobado cuyo destino ya no admite el pago (dinero cobrado
                            -- sin acreditar: requiere revision humana).
                            'legacy_invoice', 'legacy_order_payment', 'legacy_not_applied'));

create index if not exists payments_events_tx_idx
  on payments.events (transaction_id) where transaction_id is not null;

-- 1b. Guardia anti-llenado de la bandeja (B1 de la revision final) ---------------
-- Las filas `invalid_signature` y `malformed` las puede provocar CUALQUIERA que
-- conozca un payment_link_id (viaja en la URL publica del checkout). Se acotan:
-- maximo 10 filas por minuto por (clasificacion, wompi_link_id) y 300 por minuto
-- entre todas. Si se supera, NO se inserta fila nueva (el llamante recibe la misma
-- respuesta 401; la funcion devuelve `throttled: true` para que el receptor loguee).
-- Un evento VALIDO nunca pasa por aqui: no se bloquea al link legitimo.
create or replace function payments.event_flood_guard(p_class text, p_wlink text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select (select count(*) from payments.events e
           where e.classification = p_class
             and e.received_at > now() - interval '1 minute'
             and e.wompi_link_id is not distinct from p_wlink) >= 10
      or (select count(*) from payments.events e
           where e.classification in ('invalid_signature', 'malformed')
             and e.received_at > now() - interval '1 minute') >= 300;
$$;

-- 2. payments_record_legacy_event ------------------------------------------------
-- Guarda un evento de Wompi cuyo destino es una factura / link de pedido de
-- `public` (o un evento sin destino / con firma invalida). La clasificacion la
-- decide la Edge Function (necesita leer `public`); aqui solo se valida contra
-- una lista cerrada y se normalizan los campos resumen igual que
-- payments_record_event.
create or replace function public.payments_record_legacy_event(
  p_payload jsonb,
  p_environment text,
  p_signature_valid boolean,
  p_classification text,
  p_origin text,
  p_origin_ref text,
  p_expected_cents bigint default null,
  p_expected_currency text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_raw jsonb := coalesce(p_payload, 'null'::jsonb);
  v_tx jsonb;
  v_tx_id text;
  v_status text;
  v_amount bigint;
  v_currency text;
  v_wlink text;
  v_sent timestamptz;
  v_env text;
  v_class text := p_classification;
  v_amount_ok boolean;
  v_event_id bigint;
begin
  if p_classification is null or p_classification not in
     ('legacy_invoice', 'legacy_order_payment', 'legacy_not_applied', 'duplicate', 'duplicate_payment',
      'amount_mismatch', 'invalid_signature', 'unverified', 'verification_mismatch',
      'transaction_conflict', 'unknown_link') then
    raise exception 'clasificacion no permitida' using errcode = 'PY422';
  end if;
  if p_origin is not null and p_origin not in ('legacy_invoice', 'legacy_order') then
    raise exception 'origen no permitido' using errcode = 'PY422';
  end if;

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

  if p_expected_cents is not null or p_expected_currency is not null then
    v_amount_ok := not (v_amount is distinct from p_expected_cents
                        or v_currency is distinct from p_expected_currency);
  end if;

  -- payments_events_dedupe_idx cubre 'duplicate_payment': una retransmision de la
  -- misma (transaccion, estado, link) se guarda como 'duplicate' en vez de fallar.
  if v_class = 'duplicate_payment' and exists (
       select 1 from payments.events e
        where e.transaction_id is not distinct from v_tx_id
          and e.tx_status is not distinct from v_status
          and e.wompi_link_id is not distinct from v_wlink
          and e.classification in ('processed', 'duplicate_payment')) then
    v_class := 'duplicate';
  end if;

  if v_class in ('invalid_signature', 'malformed') and payments.event_flood_guard(v_class, v_wlink) then
    return jsonb_build_object('event_id', null, 'classification', v_class, 'throttled', true);
  end if;

  insert into payments.events
    (environment, wompi_link_id, link_id, transaction_id, tx_status, amount_in_cents, currency,
     sent_at, signature_valid, amount_matches, classification, raw, origin, origin_ref)
  values
    (v_env, v_wlink, null, v_tx_id, v_status, v_amount, v_currency,
     v_sent, p_signature_valid, v_amount_ok, v_class, v_raw, p_origin, left(p_origin_ref, 128))
  returning id into v_event_id;

  return jsonb_build_object('event_id', v_event_id, 'classification', v_class);
end;
$$;

-- 3. payments_transaction_usage --------------------------------------------------
-- Eventos YA aplicados/registrados con esa transaccion, para detectar que una
-- misma transaccion de Wompi se use en un segundo link/factura (B1 / (d) de la
-- fusion). Solo lectura.
create or replace function public.payments_transaction_usage(p_transaction_id text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'wompi_link_id', e.wompi_link_id, 'tx_status', e.tx_status,
           'classification', e.classification, 'origin', e.origin, 'origin_ref', e.origin_ref)),
         '[]'::jsonb)
    from payments.events e
   where p_transaction_id is not null
     and e.transaction_id = p_transaction_id
     and e.classification in ('processed', 'duplicate_payment', 'amount_mismatch', 'forwarded_foreign',
                              'legacy_invoice', 'legacy_order_payment');
$$;

-- 4. payments_record_event: el replay cruzado tambien cubre transacciones ya
--    aplicadas a una factura / pedido legacy. Unico cambio respecto de
--    20261011190000: dos clasificaciones mas en el chequeo de
--    transaction_conflict.
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
                                              'forwarded_foreign', 'legacy_invoice',
                                              'legacy_order_payment')) then
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

  -- B1 (revision final): tope de filas invalid_signature / malformed.
  if v_class in ('invalid_signature', 'malformed') and payments.event_flood_guard(v_class, v_wlink) then
    return jsonb_build_object('event_id', null, 'classification', v_class, 'link_id', null,
                              'client_id', null, 'link_status', null, 'deliveries', '[]'::jsonb,
                              'throttled', true);
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

-- 5. payments_health_summary: suma legacy_not_applied (dinero cobrado sin acreditar a su
--    pedido/factura, incluye checkout ambiguo y destino borrado). 8 -> 9 claves.
--    transaction_conflict ya contaba eventos legacy (es la misma clasificacion).
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
    'duplicate_payment',       count(*) filter (where e.classification = 'duplicate_payment'),
    'legacy_not_applied',      count(*) filter (where e.classification = 'legacy_not_applied'))
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

-- 6. Privilegios: todo public.payments_* solo para service_role (mismo bloque
--    que 20261011190000; las funciones nuevas heredan EXECUTE por defecto).
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
