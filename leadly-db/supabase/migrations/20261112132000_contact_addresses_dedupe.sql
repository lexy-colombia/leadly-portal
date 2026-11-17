-- F1 / S1.6 — Una dirección de entrega no se repite dentro del mismo cliente.
--
-- address_dedupe_key = texto normalizado (minúsculas, sin tildes, sin signos)
-- de línea 1, línea 2, municipio (código DIVIPOLA o nombre) y país. Índice
-- único parcial (tenant, cliente, key) entre direcciones vivas.
--
-- APLICAR JUNTO CON (o DESPUÉS DE) F2: desde que existe el índice, un INSERT de
-- una dirección ya guardada del mismo cliente falla con 23505, constraint
-- `contact_addresses_unique_address_per_client`. storefront, whatsapp-ai-tools
-- (save_contact_address) y addresses.ts deben reutilizar la existente al ver
-- ese código. Editar un duplicado PREEXISTENTE sin cambiar su texto de
-- dirección NO falla: la clave solo se recalcula si cambian los campos que la
-- componen.
--
-- Los duplicados que YA existen no se borran ni se modifican: el más
-- representativo de cada grupo (predeterminada, luego la más antigua) conserva
-- la clave y los demás quedan con clave NULL (el índice único ignora NULL).
-- Quedan listados en la vista contact_addresses_duplicate_review. Si luego
-- alguien edita una dirección duplicada y vuelve a colisionar, el índice la
-- rechaza (23505).

create or replace function public.contact_address_dedupe_key(
  p_line1 text, p_line2 text, p_city text, p_city_code text, p_country text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when regexp_replace(translate(lower(coalesce(p_line1, '')), 'áàäâéèëêíìïîóòöôúùüûñ', 'aaaaeeeeiiiioooouuuun'), '[^a-z0-9]+', '', 'g') = '' then null else concat_ws('|',
    regexp_replace(translate(lower(coalesce(p_line1, '')), 'áàäâéèëêíìïîóòöôúùüûñ', 'aaaaeeeeiiiioooouuuun'), '[^a-z0-9]+', '', 'g'),
    regexp_replace(translate(lower(coalesce(p_line2, '')), 'áàäâéèëêíìïîóòöôúùüûñ', 'aaaaeeeeiiiioooouuuun'), '[^a-z0-9]+', '', 'g'),
    coalesce(
      nullif(btrim(p_city_code), ''),
      regexp_replace(translate(lower(coalesce(p_city, '')), 'áàäâéèëêíìïîóòöôúùüûñ', 'aaaaeeeeiiiioooouuuun'), '[^a-z0-9]+', '', 'g')
    ),
    case when lower(btrim(coalesce(p_country, ''))) in ('', 'co', 'colombia') then 'co'
         else regexp_replace(lower(btrim(p_country)), '[^a-z0-9]+', '', 'g') end
  ) end
$$;

alter table public.contact_addresses add column address_dedupe_key text;

create or replace function public.contact_addresses_set_dedupe_key()
returns trigger
language plpgsql
set search_path = ''
as $$
declare v_new text := public.contact_address_dedupe_key(new.line1, new.line2, new.city, new.city_code, new.country);
begin
  -- En UPDATE solo se recalcula si cambian los campos que componen la clave
  -- (editar un duplicado preexistente sin tocar su dirección no choca).
  if tg_op = 'UPDATE'
     and v_new is not distinct from public.contact_address_dedupe_key(old.line1, old.line2, old.city, old.city_code, old.country) then
    return new;
  end if;
  new.address_dedupe_key := v_new;
  return new;
end;
$$;
revoke execute on function public.contact_addresses_set_dedupe_key() from public, anon, authenticated;

-- Backfill: sin tocar updated_at (se apaga solo ese trigger) ni borrar filas.
alter table public.contact_addresses disable trigger contact_addresses_set_updated_at;
with keyed as (
  select a.id,
         public.contact_address_dedupe_key(a.line1, a.line2, a.city, a.city_code, a.country) as k,
         row_number() over (
           partition by a.tenant_id, a.contact_id,
             public.contact_address_dedupe_key(a.line1, a.line2, a.city, a.city_code, a.country)
           order by a.is_default desc, a.created_at, a.id
         ) as rn
    from public.contact_addresses a
   where a.deleted_at is null
)
update public.contact_addresses a
   set address_dedupe_key = case when keyed.rn = 1 then keyed.k end
  from keyed
 where a.id = keyed.id;
-- Eliminadas: clave informativa (el índice las excluye).
update public.contact_addresses a
   set address_dedupe_key = public.contact_address_dedupe_key(a.line1, a.line2, a.city, a.city_code, a.country)
 where a.deleted_at is not null;
alter table public.contact_addresses enable trigger contact_addresses_set_updated_at;

create trigger contact_addresses_set_dedupe_key
  before insert or update of line1, line2, city, city_code, country on public.contact_addresses
  for each row execute function public.contact_addresses_set_dedupe_key();

create unique index contact_addresses_unique_address_per_client
  on public.contact_addresses (tenant_id, contact_id, address_dedupe_key)
  where deleted_at is null and address_dedupe_key is not null;

create or replace view public.contact_addresses_duplicate_review
with (security_invoker = true) as
select a.tenant_id, a.contact_id as client_id, a.id as address_id, s.id as kept_address_id,
       a.line1, a.line2, a.city, a.country, a.is_default, a.created_at
  from public.contact_addresses a
  join public.contact_addresses s
    on s.tenant_id = a.tenant_id and s.contact_id = a.contact_id and s.deleted_at is null
   and s.address_dedupe_key = public.contact_address_dedupe_key(a.line1, a.line2, a.city, a.city_code, a.country)
 where a.deleted_at is null and a.address_dedupe_key is null;

comment on view public.contact_addresses_duplicate_review is
  'Direcciones vivas duplicadas dentro del mismo cliente que F1 no borra (clave NULL); kept_address_id es la que conserva la clave.';
revoke all on public.contact_addresses_duplicate_review from anon;

do $$
declare v_dups int;
begin
  select count(*) into v_dups from public.contact_addresses where deleted_at is null and address_dedupe_key is null;
  raise notice 'contact_addresses dedupe: % direcciones duplicadas conservadas sin clave (ver contact_addresses_duplicate_review).', v_dups;
end $$;
