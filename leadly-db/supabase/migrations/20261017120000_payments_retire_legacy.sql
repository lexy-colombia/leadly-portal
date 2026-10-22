-- Retiro de la rama legacy del servicio de pagos (ST5 de progress/feature_wompi_unified_service.md).
--
-- Todo link de Wompi se crea por el servicio (payments.payment_links); el receptor ya no
-- consulta payment_invoices ni sales_order_payment_links. Esta migracion elimina el SQL que
-- solo servia a esa rama.
--
-- ORDEN DE DESPLIEGUE (sin staging) -- esta migracion va DESPUES de desplegar el codigo nuevo:
--   1. desplegar payments-api y create-payment-checkout (ya no llaman a nada de lo que aqui
--      se borra; funcionan contra el SQL VIEJO y contra el NUEVO);
--   2. aplicar esta migracion.
-- Si se aplicara antes, el payments-api viejo fallaria al registrar eventos sin destino
-- (payments_record_legacy_event) y create-payment-checkout viejo al leer provider_checkout_id.
--
-- NO toca datos. Los borrados de prueba (links de pedido, pagos Wompi de agosto) van en otra
-- migracion gateada que DEBE correr antes de esta: aqui hay guardas que ABORTAN si todavia
-- queda una fila en sales_order_payment_links o un payment_invoices.provider_checkout_id.
--
-- Se CONSERVAN (historia inmutable, payments.events es solo-insertar): los valores legacy_*
-- de events_classification_check, events_origin_check y las columnas origin/origin_ref.
--
-- Idempotente: create or replace / drop ... if exists. Firmas de las funciones que se
-- reescriben sin cambios (compatibles hacia atras).

-- 0. Guardas: no se borra la tabla ni la columna si todavia guardan datos ---------------------
do $$
begin
  if to_regclass('public.sales_order_payment_links') is not null then
    if exists (select 1 from public.sales_order_payment_links) then
      raise exception 'public.sales_order_payment_links aun tiene filas: correr primero la limpieza de datos de prueba (migracion gateada)'
        using errcode = 'PY409';
    end if;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'payment_invoices' and column_name = 'provider_checkout_id') then
    if exists (select 1 from public.payment_invoices where provider_checkout_id is not null) then
      raise exception 'payment_invoices.provider_checkout_id aun tiene valores: no se puede borrar la columna'
        using errcode = 'PY409';
    end if;
  end if;
end $$;

-- 1. payments_record_event ------------------------------------------------------------------
-- Cuerpo identico al de 20261011210000 (seccion 4). Unica rama que menciona clasificaciones
-- legacy: el chequeo de replay cruzado (transaction_conflict) sigue contando los eventos
-- historicos legacy_invoice / legacy_order_payment: una transaccion que la rama vieja ya acredito
-- no puede reutilizarse bajo un link del servicio. No se crean eventos legacy nuevos.
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

-- 2. payments_public_link_status: sin busqueda por origin_ref ni clasificaciones legacy ---------
-- Un id que no es de payments.payment_links responde {found:false}: el router publica "unknown".
create or replace function public.payments_public_link_status(p_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_link payments.payment_links%rowtype;
  v_found boolean := false;
  v_attempt text;
begin
  if p_id is null then
    return jsonb_build_object('found', false, 'status', null, 'last_attempt', null, 'updated_at', null);
  end if;

  select * into v_link from payments.payment_links where id = p_id;
  v_found := found;

  if v_found then
    select e.tx_status into v_attempt
      from payments.events e
     where e.link_id = p_id
       and e.tx_status in ('APPROVED', 'DECLINED', 'VOIDED', 'ERROR')
       and e.classification in ('processed', 'duplicate_payment')
     order by e.id desc
     limit 1;
  end if;

  return jsonb_build_object(
    'found', v_found,
    'status', case when v_found then v_link.status else null end,
    'last_attempt', v_attempt,
    'updated_at', case when v_found then v_link.updated_at else null end
  );
end;
$$;

-- 3. payments_health_summary: sin la clave legacy_not_applied (9 -> 8 claves) -----------------------
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

-- 4. Funciones que solo usaba la rama legacy --------------------------------------------------------
drop function if exists public.payments_record_legacy_event(jsonb, text, boolean, text, text, text, bigint, text);
drop function if exists public.payments_transaction_usage(text);

-- 5. Tabla y columna del origen legacy ------------------------------------------------------------------
-- sales_order_payments.payment_link_id ya no tiene FK a esta tabla (20261016130000); sin CASCADE a
-- proposito: si algo mas la referenciara, la migracion falla en vez de borrarlo.
drop table if exists public.sales_order_payment_links;

drop index if exists public.payment_invoices_provider_checkout_id_idx;
alter table if exists public.payment_invoices drop column if exists provider_checkout_id;

-- 6. Privilegios: mismo bloque que las migraciones previas (todo public.payments_* solo service_role).
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
