-- F1 / S1.2 — Backfill único de client_billing_profiles desde clients.
--
-- Fuente: clients (documento, correo, nombre, retención) + clients.billing_profile
-- (razón social, régimen, dirección fiscal, correo). Se COPIA una sola vez; el
-- perfil queda autosuficiente. `clients` NO se modifica.
--
-- Alcance: clientes vivos, NO walk-in (Consumidor Final no lleva perfil), con
-- documento o con datos fiscales (billing_profile no vacío o retención).
-- Idempotente: no toca a un cliente que ya tenga algún perfil (vivo o no).
--
-- Código de municipio (DIVIPOLA): solo se resuelve por nombre cuando es
-- inequívoco (mismo criterio que 20261111035715). Lo ambiguo queda sin código
-- y aparece en la vista de revisión.

create temp table _bp_expected as
select c.id as client_id, c.tenant_id
from public.clients c
where c.deleted_at is null
  and not c.is_walk_in
  and (
    nullif(btrim(c.document_number), '') is not null
    or c.billing_profile <> '{}'::jsonb
    or c.applies_withholding
  );

with src as (
  select
    c.*,
    nullif(btrim(c.billing_profile #>> '{address,line1}'), '') as a_line1,
    nullif(btrim(c.billing_profile #>> '{address,line2}'), '') as a_line2,
    upper(nullif(btrim(c.billing_profile #>> '{address,country}'), '')) as a_country,
    nullif(btrim(c.billing_profile #>> '{address,city}'), '') as a_city,
    nullif(btrim(c.billing_profile #>> '{address,state_province}'), '') as a_state,
    nullif(btrim(c.billing_profile #>> '{address,city_code}'), '') as a_city_code,
    nullif(btrim(c.billing_profile #>> '{address,state_code}'), '') as a_state_code
  from public.clients c
  join _bp_expected e on e.client_id = c.id
  where not exists (select 1 from public.client_billing_profiles p where p.client_id = c.id)
),
norm as (
  select
    s.*,
    -- Los códigos DIVIPOLA solo valen si la pareja existe en cities.
    exists (
      select 1 from public.cities ci
      where ci.code = s.a_city_code and ci.department_code = s.a_state_code
    ) as geo_ok
  from src s
)
insert into public.client_billing_profiles (
  tenant_id, client_id, label, is_default,
  document_type_code, document_number, legal_name, email, phone,
  organization_type, tax_level_code, tax_scheme_code, applies_withholding, delivery_method,
  address_line1, address_line2, country, state_code, city_code, state_province, city
)
select
  n.tenant_id, n.id, 'Principal', true,
  case when n.dian_document_type_code in (select code from public.document_types) then n.dian_document_type_code end,
  nullif(btrim(n.document_number), ''),
  coalesce(nullif(btrim(n.billing_profile ->> 'legal_name'), ''), nullif(btrim(n.full_name), '')),
  coalesce(nullif(btrim(n.billing_profile ->> 'email'), ''), nullif(btrim(n.email), '')),
  nullif(btrim(n.phone), ''),
  case
    when n.billing_profile ->> 'organization_type' in ('1', '2') then n.billing_profile ->> 'organization_type'
    when n.dian_document_type_code in ('31', '50') then '1'
    else '2'
  end,
  coalesce(nullif(n.billing_profile ->> 'tax_level_code', ''), 'R-99-PN'),
  nullif(n.billing_profile ->> 'tax_scheme_code', ''),
  n.applies_withholding,
  coalesce(nullif(n.billing_profile ->> 'delivery_method', ''), 'email'),
  n.a_line1,
  n.a_line2,
  -- País: el declarado si existe en el catálogo; si no, Colombia únicamente
  -- cuando traía códigos DIVIPOLA válidos (esos códigos solo existen en CO).
  case
    when n.a_country in (select code from public.countries) then n.a_country
    when n.geo_ok then 'CO'
  end,
  case when n.geo_ok and (n.a_country is null or n.a_country = 'CO') then n.a_state_code end,
  case when n.geo_ok and (n.a_country is null or n.a_country = 'CO') then n.a_city_code end,
  n.a_state,
  n.a_city
from norm n;

-- DIVIPOLA por nombre, solo si hay exactamente un municipio que calza (y, si el
-- perfil trae departamento, que el departamento también calce).
with matches as (
  select p.id, min(ci.code) as city_code, min(ci.department_code) as state_code
  from public.client_billing_profiles p
  join public.cities ci on lower(btrim(ci.name)) = lower(btrim(p.city))
  join public.departments d on d.code = ci.department_code
  where p.country = 'CO' and p.city_code is null and p.deleted_at is null
    and nullif(btrim(p.city), '') is not null
    and (nullif(btrim(p.state_province), '') is null or lower(btrim(d.name)) = lower(btrim(p.state_province)))
  group by p.id
  having count(*) = 1
)
update public.client_billing_profiles p
   set city_code = m.city_code, state_code = m.state_code
  from matches m
 where p.id = m.id;

-- Guarda: todo cliente elegible quedó con perfil. Aborta si no.
do $$
declare
  v_expected int;
  v_missing int;
  v_created int;
  v_incomplete int;
begin
  select count(*) into v_expected from _bp_expected;
  select count(*) into v_missing
    from _bp_expected e
   where not exists (select 1 from public.client_billing_profiles p where p.client_id = e.client_id);
  if v_missing > 0 then
    raise exception 'client_billing_profiles backfill: % de % clientes elegibles quedaron sin perfil; se aborta.', v_missing, v_expected;
  end if;

  select count(*) into v_created
    from public.client_billing_profiles p join _bp_expected e on e.client_id = p.client_id;
  select count(*) into v_incomplete
    from public.client_billing_profiles p
   where p.deleted_at is null
     and (p.document_type_code is null or p.document_number is null or p.legal_name is null or p.email is null);

  raise notice 'client_billing_profiles backfill: % clientes elegibles, % con perfil, % perfiles incompletos (ver vista client_billing_profile_review).',
    v_expected, v_created, v_incomplete;
end $$;

drop table _bp_expected;

-- ---------------------------------------------------------------------------
-- Vistas de revisión (security_invoker: RLS del llamador; sin acceso anónimo)
-- ---------------------------------------------------------------------------
-- Una fila por perfil con problemas. `issues` lista qué falta.
create or replace view public.client_billing_profile_review
with (security_invoker = true) as
select
  p.tenant_id,
  p.client_id,
  c.full_name as client_name,
  p.id as profile_id,
  array_remove(array[
    case when p.document_type_code is null then 'tipo de documento' end,
    case when p.document_number is null then 'número de documento' end,
    case when p.legal_name is null then 'nombre legal' end,
    case when p.email is null then 'correo'
         when p.email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then 'correo inválido' end,
    case when p.address_line1 is not null and p.country is null then 'país del domicilio' end,
    case when p.country = 'CO' and p.address_line1 is not null and p.city_code is null then 'municipio (DIVIPOLA) sin resolver' end,
    case when p.address_line1 is null and (
        select count(*) from public.contact_addresses a
        where a.tenant_id = p.tenant_id and a.contact_id = p.client_id
          and a.deleted_at is null and a.is_billing) > 1 then 'varias direcciones fiscales candidatas, sin domicilio elegido' end
  ], null) as issues
from public.client_billing_profiles p
join public.clients c on c.id = p.client_id and c.tenant_id = p.tenant_id
where p.deleted_at is null;

comment on view public.client_billing_profile_review is
  'Perfiles de facturación con datos faltantes (columna issues no vacía). Filtrar: where cardinality(issues) > 0.';

-- Direcciones marcadas SOLO como facturación (no envío): no se mueven ni se
-- borran en F1; quedan para revisión humana (F5 retira is_billing/is_shipping).
create or replace view public.contact_addresses_billing_only_review
with (security_invoker = true) as
select
  a.tenant_id, a.contact_id as client_id, c.full_name as client_name,
  a.id as address_id, a.line1, a.line2, a.city, a.state_province, a.country,
  a.is_default,
  exists (
    select 1 from public.client_billing_profiles p
    where p.tenant_id = a.tenant_id and p.client_id = a.contact_id
      and p.deleted_at is null and p.address_line1 is not null
  ) as client_has_profile_address
from public.contact_addresses a
join public.clients c on c.id = a.contact_id and c.tenant_id = a.tenant_id
where a.deleted_at is null and a.is_billing and not a.is_shipping;

comment on view public.contact_addresses_billing_only_review is
  'Direcciones activas solo-facturación (no envío) que F1 no migra; revisión manual.';

revoke all on public.client_billing_profile_review from anon;
revoke all on public.contact_addresses_billing_only_review from anon;
