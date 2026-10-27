-- ST4 (feature_api_hardening, Fase B): saldos y listados de clientes en el
-- servidor, en lugar de sumarse / paginarse en el navegador.
--
-- Problema real que cierra: credit.ts, dashboardOverview.ts y ClientDetail.tsx
-- calculaban "cargos - pagos" sumando en el cliente las filas que PostgREST
-- devolvia, y PostgREST corta en 1000 filas sin error -> el saldo de cartera
-- salia mal en silencio al pasar de 1000 movimientos. getStoreCreditBalance
-- sumaba solo los grants e ignoraba las redenciones (el trigger
-- apply_store_credit_redemption si las resta). listClients bajaba (y truncaba
-- a 1000) todos los clientes del tenant.
--
-- REGLA VIGENTE DE SALDO DE CREDITO (reproducida SIN cambiarla, identica en
-- las tres copias del cliente):
--   saldo = sum(credit_charges.amount) - sum(credit_payments.amount
--           donde deleted_at is null)
--   * los cargos NO se filtran por pedido anulado / borrado (credit_charges
--     no tiene deleted_at; ya documentado en CLAUDE.md 2026-09-21: anular la
--     venta no revierte el cargo).
--   * la cartera lista solo clientes con credit_enabled y no borrados.
-- REGLA DE SALDO A FAVOR (la del trigger, que es la autoritativa):
--   saldo = sum(store_credit_grants) - sum(store_credit_redemptions)
--
-- Seguridad: todas SECURITY INVOKER -> corre con la RLS del llamador, es decir
-- exactamente la visibilidad que ya tenian las consultas directas; ademas el
-- tenant se resuelve en el servidor (auth_active_tenant_id() o el tenant de la
-- fila del cliente) y nunca llega por parametro. revoke a public/anon; grant a
-- authenticated y service_role (el frontend las invoca con el JWT del usuario).

-- 1. Saldo de credito de un cliente -------------------------------------
create or replace function public.get_client_credit_summary(p_client_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'total_charged', coalesce((
      select sum(ch.amount) from public.credit_charges ch
      where ch.client_id = c.id and ch.tenant_id = c.tenant_id), 0),
    'total_paid', coalesce((
      select sum(p.amount) from public.credit_payments p
      where p.client_id = c.id and p.tenant_id = c.tenant_id and p.deleted_at is null), 0),
    'balance', coalesce((
      select sum(ch.amount) from public.credit_charges ch
      where ch.client_id = c.id and ch.tenant_id = c.tenant_id), 0)
      - coalesce((
      select sum(p.amount) from public.credit_payments p
      where p.client_id = c.id and p.tenant_id = c.tenant_id and p.deleted_at is null), 0)
  )
  from public.clients c
  where c.id = p_client_id;   -- cliente no visible / inexistente -> null (no ceros inventados)
$$;

-- 2. Cartera: clientes con credito, paginada, con totales de toda la cartera
create or replace function public.list_credit_clients(
  p_page integer default 1,
  p_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_active_tenant_id();
  v_size integer := least(greatest(coalesce(p_page_size, 10), 1), 100);
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_rows jsonb;
  v_summary jsonb;
begin
  if v_tenant is null then
    return jsonb_build_object(
      'rows', '[]'::jsonb,
      'total', 0,
      'summary', jsonb_build_object('clients', 0, 'with_balance', 0, 'total_charged', 0, 'total_paid', 0, 'total_balance', 0)
    );
  end if;

  with base as (
    select c.id, c.full_name,
           coalesce((select sum(ch.amount) from public.credit_charges ch where ch.client_id = c.id and ch.tenant_id = v_tenant), 0) as total_charged,
           coalesce((select sum(p.amount) from public.credit_payments p where p.client_id = c.id and p.tenant_id = v_tenant and p.deleted_at is null), 0) as total_paid
    from public.clients c
    where c.tenant_id = v_tenant and c.credit_enabled = true and c.deleted_at is null
  ),
  pg as (
    select * from base order by full_name, id offset (v_page - 1) * v_size limit v_size
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
                'client', jsonb_build_object('id', pg.id, 'full_name', pg.full_name),
                'total_charged', pg.total_charged,
                'total_paid', pg.total_paid,
                'balance', pg.total_charged - pg.total_paid) order by pg.full_name, pg.id) from pg), '[]'::jsonb),
    (select jsonb_build_object(
        'clients', count(*),
        'with_balance', count(*) filter (where total_charged - total_paid > 0),
        'total_charged', coalesce(sum(total_charged), 0),
        'total_paid', coalesce(sum(total_paid), 0),
        'total_balance', coalesce(sum(total_charged - total_paid), 0)) from base)
  into v_rows, v_summary;

  return jsonb_build_object('rows', v_rows, 'total', (v_summary->>'clients')::bigint, 'summary', v_summary);
end;
$$;

-- 3. Saldo a favor (grants - redemptions, regla del trigger) ----------------
create or replace function public.get_client_store_credit_balance(p_client_id uuid)
returns numeric
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce((select sum(g.amount) from public.store_credit_grants g
                    where g.client_id = c.id and g.tenant_id = c.tenant_id), 0)
       - coalesce((select sum(r.amount) from public.store_credit_redemptions r
                    where r.client_id = c.id and r.tenant_id = c.tenant_id), 0)
  from public.clients c
  where c.id = p_client_id;
$$;

-- 4. Listado paginado de clientes con los filtros de Clients.tsx ------------
-- Reproduce en SQL lo que la pantalla hacia en memoria: busqueda (nombre,
-- telefono, indicativo, empresa, cualquier etiqueta; subcadena sin distinguir
-- mayusculas), etiqueta exacta, agente y filtro por campo personalizado
-- (misma semantica que matchesCustomFieldFilter). Orden: updated_at desc.
create or replace function public.list_clients_page(
  p_search text default null,
  p_tag text default null,
  p_agent uuid default null,
  p_cf_field uuid default null,
  p_cf_operator text default null,
  p_cf_value text default null,
  p_page integer default 1,
  p_page_size integer default 8
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_active_tenant_id();
  v_size integer := least(greatest(coalesce(p_page_size, 8), 1), 100);
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_term text := lower(btrim(coalesce(p_search, '')));
  v_cf_type text;
  v_operand text := btrim(coalesce(p_cf_value, ''));
  v_use_cf boolean := false;
  v_num_re constant text := '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$';
  v_total bigint;
  v_rows jsonb;
  v_tags jsonb;
begin
  if v_tenant is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'total', 0, 'all_tags', '[]'::jsonb);
  end if;

  if p_cf_field is not null and v_operand <> '' then
    select d.field_type into v_cf_type
    from public.custom_field_definitions d
    where d.id = p_cf_field and d.tenant_id = v_tenant and d.entity_type = 'client'
      and d.is_active and d.deleted_at is null;
    v_use_cf := v_cf_type is not null;   -- definicion inexistente/inactiva -> sin filtro (igual que la pantalla)
  end if;

  with filtered as (
    select c.id, c.updated_at
    from public.clients c
  where c.tenant_id = v_tenant and c.deleted_at is null
    and (p_tag is null or p_tag = any(c.tags))
    and (p_agent is null or c.assigned_to = p_agent)
    and (v_term = '' or
         strpos(lower(c.full_name), v_term) > 0 or
         strpos(c.phone, v_term) > 0 or
         strpos(c.phone_prefix, v_term) > 0 or
         strpos(lower(coalesce(c.company, '')), v_term) > 0 or
         exists (select 1 from unnest(c.tags) tg where strpos(lower(tg), v_term) > 0))
    and (not v_use_cf or (
         (c.custom_fields ->> p_cf_field::text) is not null
         and (c.custom_fields ->> p_cf_field::text) <> ''
         and case v_cf_type
           when 'text' then
             case when p_cf_operator = 'contains'
                  then strpos(lower(c.custom_fields ->> p_cf_field::text), lower(v_operand)) > 0
                  else lower(c.custom_fields ->> p_cf_field::text) = lower(v_operand) end
           when 'integer' then
             case when v_operand ~ v_num_re and (c.custom_fields ->> p_cf_field::text) ~ v_num_re then
               case p_cf_operator
                 when 'gt' then (c.custom_fields ->> p_cf_field::text)::numeric > v_operand::numeric
                 when 'lt' then (c.custom_fields ->> p_cf_field::text)::numeric < v_operand::numeric
                 else (c.custom_fields ->> p_cf_field::text)::numeric = v_operand::numeric end
             else false end
           when 'decimal' then
             case when v_operand ~ v_num_re and (c.custom_fields ->> p_cf_field::text) ~ v_num_re then
               case p_cf_operator
                 when 'gt' then (c.custom_fields ->> p_cf_field::text)::numeric > v_operand::numeric
                 when 'lt' then (c.custom_fields ->> p_cf_field::text)::numeric < v_operand::numeric
                 else (c.custom_fields ->> p_cf_field::text)::numeric = v_operand::numeric end
             else false end
           when 'date' then
             case p_cf_operator
               when 'before' then (c.custom_fields ->> p_cf_field::text) < v_operand
               when 'after' then (c.custom_fields ->> p_cf_field::text) > v_operand
               else (c.custom_fields ->> p_cf_field::text) = v_operand end
           else (c.custom_fields ->> p_cf_field::text) = v_operand
         end))
  ),
  pg as (
    select * from filtered order by updated_at desc, id offset (v_page - 1) * v_size limit v_size
  )
  select
    (select count(*) from filtered),
    coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object('last_contact_at', (
                 select max(w.last_message_at) from public.whatsapp_conversations w
                 where w.contact_id = c.id and w.tenant_id = v_tenant and w.last_message_at is not null))
               order by pg.updated_at desc, pg.id)
             from pg join public.clients c on c.id = pg.id), '[]'::jsonb)
  into v_total, v_rows;

  -- Etiquetas del tenant para el filtro (antes salian de bajar todos los clientes).
  select coalesce(jsonb_agg(tg order by tg), '[]'::jsonb) into v_tags
  from (select distinct unnest(c.tags) as tg from public.clients c
        where c.tenant_id = v_tenant and c.deleted_at is null) t;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'all_tags', v_tags);
end;
$$;

-- 5. Clientes por telefono completo (prefijo + numero), para reconstruir los
-- destinatarios de una campana duplicada sin bajar todo el tenant. ----------
create or replace function public.find_clients_by_full_phone(p_phones text[])
returns setof public.clients
language sql
stable
security invoker
set search_path = public
as $$
  select c.*
  from public.clients c
  where c.tenant_id = public.auth_active_tenant_id()
    and c.deleted_at is null
    and (c.phone_prefix || regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')) = any (p_phones)
  limit 1000;
$$;

-- Privilegios: nada para public/anon; el frontend las llama con el JWT.
revoke all on function public.get_client_credit_summary(uuid) from public, anon;
revoke all on function public.list_credit_clients(integer, integer) from public, anon;
revoke all on function public.get_client_store_credit_balance(uuid) from public, anon;
revoke all on function public.list_clients_page(text, text, uuid, uuid, text, text, integer, integer) from public, anon;
revoke all on function public.find_clients_by_full_phone(text[]) from public, anon;
grant execute on function public.get_client_credit_summary(uuid) to authenticated, service_role;
grant execute on function public.list_credit_clients(integer, integer) to authenticated, service_role;
grant execute on function public.get_client_store_credit_balance(uuid) to authenticated, service_role;
grant execute on function public.list_clients_page(text, text, uuid, uuid, text, text, integer, integer) to authenticated, service_role;
grant execute on function public.find_clients_by_full_phone(text[]) to authenticated, service_role;
