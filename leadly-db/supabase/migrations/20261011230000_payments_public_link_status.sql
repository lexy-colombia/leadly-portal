-- Estado PUBLICO y minimo de un cobro, para la pagina de retorno de Wompi
-- (/pago/resultado del SPA, via payments-api GET /v1/public/payment-links/{id}/status).
--
-- Solo lectura. Devuelve unicamente lo necesario para pintar la pagina:
--   { found, status, last_attempt, updated_at }
-- NADA de montos, referencias, nombres, correos, ids de proveedor ni tenant.
--
--  * found = true  -> p_id es un payments.payment_links.id; status = estado del link
--                     ('creating' se publica como 'pending' en el router).
--  * found = false -> p_id no es un link del servicio nuevo; el router lo busca en
--                     las tablas legacy (legacyStore.publicStatus). last_attempt se
--                     calcula igual, por origin_ref (los eventos legacy lo guardan).
--  last_attempt = tx_status (APPROVED|DECLINED|VOIDED|ERROR) del ultimo evento
--  VALIDO (clasificacion processed / duplicate_payment / legacy_invoice /
--  legacy_order_payment) de ese cobro; null si no hay. Las filas invalid_signature
--  / malformed NO cuentan: las puede provocar cualquiera que conozca un id.
--
-- Idempotente (create or replace / create index if not exists). Nueva migracion:
-- no edita ninguna ya aplicada. Grants: solo service_role (bloque del final).

create index if not exists payments_events_origin_ref_idx
  on payments.events (origin_ref, id desc)
  where origin_ref is not null;

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

  select e.tx_status into v_attempt
    from payments.events e
   where (e.link_id = p_id or e.origin_ref = p_id::text)
     and e.tx_status in ('APPROVED', 'DECLINED', 'VOIDED', 'ERROR')
     and e.classification in ('processed', 'duplicate_payment', 'legacy_invoice', 'legacy_order_payment')
   order by e.id desc
   limit 1;

  return jsonb_build_object(
    'found', v_found,
    'status', case when v_found then v_link.status else null end,
    'last_attempt', v_attempt,
    'updated_at', case when v_found then v_link.updated_at else null end
  );
end;
$$;

-- Privilegios: mismo bloque que 20261011190000 / 20261011210000 (todo
-- public.payments_* solo para service_role; nada para anon/authenticated).
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
