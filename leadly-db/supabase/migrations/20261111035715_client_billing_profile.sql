alter table public.clients
  add column billing_profile jsonb not null default '{}'::jsonb,
  add constraint clients_billing_profile_shape check (
    jsonb_typeof(billing_profile) = 'object'
    and (billing_profile ->> 'organization_type' is null or billing_profile ->> 'organization_type' in ('1', '2'))
    and (billing_profile ->> 'tax_scheme_code' is null or billing_profile ->> 'tax_scheme_code' in ('01', '04', 'ZA', 'ZZ'))
    and (billing_profile ->> 'tax_level_code' is null or billing_profile ->> 'tax_level_code' ~ '^(R-99-PN|O-(13|15|23|47)(;O-(13|15|23|47))*)$')
    and (billing_profile ->> 'delivery_method' is null or billing_profile ->> 'delivery_method' in ('email', 'print'))
    and (billing_profile ->> 'address' is null or jsonb_typeof(billing_profile -> 'address') = 'object')
  );

-- Copy a legacy address only when there is a single choice or a single default.
with candidates as (
  select a.*,
    count(*) over (partition by a.tenant_id, a.contact_id) as address_count,
    count(*) filter (where a.is_default) over (partition by a.tenant_id, a.contact_id) as default_count
  from public.contact_addresses a
  where a.is_billing and a.deleted_at is null and nullif(btrim(a.line1), '') is not null
    and a.line1 !~* 'no registrad|sin direcci[oó]n|pendiente|desconocid|por definir|^n/a$'
)
update public.clients c
set billing_profile = jsonb_build_object('address', jsonb_build_object(
  'line1', concat_ws(', ', btrim(a.line1), nullif(btrim(a.line2), '')),
  'city', a.city, 'state_province', a.state_province,
  'country', case
    when lower(btrim(a.country)) = 'colombia' then 'CO'
    when upper(btrim(a.country)) ~ '^[A-Z]{2}$' then upper(btrim(a.country))
    else null end,
  'city_code', a.city_code, 'state_code', a.state_code
))
from candidates a
where c.id = a.contact_id and c.tenant_id = a.tenant_id
  and c.deleted_at is null and not c.is_walk_in
  and (a.address_count = 1 or (a.default_count = 1 and a.is_default));

-- Resolve only unique matches in DIVIPOLA. Leave ambiguous entries for review.
with matches as (
  select c.id, min(city.code) as city_code, min(city.department_code) as state_code
  from public.clients c
  join public.cities city
    on lower(btrim(city.name)) = lower(btrim(c.billing_profile #>> '{address,city}'))
  join public.departments d on d.code = city.department_code
  where c.billing_profile #>> '{address,country}' = 'CO'
    and (c.billing_profile #>> '{address,city_code}') is null
    and (nullif(btrim(c.billing_profile #>> '{address,state_province}'), '') is null
         or lower(btrim(d.name)) = lower(btrim(c.billing_profile #>> '{address,state_province}')))
    and (c.billing_profile #>> '{address,state_code}' is null
         or d.code = c.billing_profile #>> '{address,state_code}')
  group by c.id
  having count(*) = 1
)
update public.clients c
set billing_profile = jsonb_set(
  jsonb_set(c.billing_profile, '{address,city_code}', to_jsonb(m.city_code)),
  '{address,state_code}', to_jsonb(m.state_code)
)
from matches m where c.id = m.id;

-- Keep stock and delivery checks. Fiscal data is validated when issuing.
create or replace function public.guard_sales_order_confirmation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_item record;
  v_physical numeric;
  v_reserved numeric;
  v_available numeric;
  v_address_id uuid;
  v_items jsonb;
  v_mat uuid;
  v_short record;
begin
  if new.sales_channel is distinct from 'pos' then
    for v_item in
      select soi.product_id, soi.variant_id, soi.product_name, soi.quantity
      from public.sales_order_items soi
      join public.products p on p.id = soi.product_id
      where soi.order_id = new.id and soi.product_id is not null and p.track_inventory = true
        and p.inventory_mode = 'stock'
      order by soi.product_id, soi.variant_id nulls first
    loop
      perform pg_advisory_xact_lock(
        hashtextextended(new.tenant_id::text || ':' || v_item.product_id::text || ':' || coalesce(v_item.variant_id::text, ''), 0)
      );

      if v_item.variant_id is not null then
        select coalesce(sum(quantity), 0) into v_physical
        from public.product_stock
        where tenant_id = new.tenant_id and variant_id = v_item.variant_id;
      else
        select coalesce(sum(quantity), 0) into v_physical
        from public.product_stock
        where tenant_id = new.tenant_id and product_id = v_item.product_id;
      end if;

      select coalesce(sum(r.quantity), 0) into v_reserved
      from public.stock_reservations r
      where r.tenant_id = new.tenant_id
        and r.product_id = v_item.product_id
        and (v_item.variant_id is null or r.variant_id is not distinct from v_item.variant_id)
        and (r.expires_at is null or r.expires_at > now())
        and (new.cart_id is null or r.cart_id <> new.cart_id);

      v_available := v_physical - v_reserved;

      if v_available < v_item.quantity then
        raise exception 'INSUFFICIENT_STOCK: Stock insuficiente para confirmar "%": disponible %, pedido %.', v_item.product_name, greatest(0, v_available), v_item.quantity;
      end if;
    end loop;

    -- Insumos de los productos 'recipe' (después de los productos: mismo orden
    -- de locks que sync_cart_reservations).
    select coalesce(jsonb_agg(jsonb_build_object('product_id', soi.product_id, 'quantity', soi.quantity)), '[]'::jsonb)
      into v_items
      from public.sales_order_items soi
     where soi.order_id = new.id and soi.product_id is not null;

    for v_mat in
      select distinct d.material_id from public.recipe_demand_lines(new.tenant_id, v_items) d order by 1
    loop
      perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text || ':m:' || v_mat::text, 0));
    end loop;

    select * into v_short
      from public.recipe_shortfalls(new.tenant_id, v_items, new.cart_id)
     order by product_id, material_id
     limit 1;
    if found then
      if v_short.material_id is null then
        raise exception 'INSUFFICIENT_STOCK: El producto "%" no tiene ficha técnica y no se puede confirmar.', v_short.product_name;
      end if;
      raise exception 'INSUFFICIENT_STOCK: Insumo insuficiente para confirmar "%": "%" disponible % %, requerido % %.',
        v_short.product_name, v_short.material_name, v_short.material_available, v_short.unit, v_short.material_required, v_short.unit;
    end if;

    -- Dirección de envío.
    if new.shipping_address_id is null then
      select id into v_address_id
      from public.contact_addresses
      where tenant_id = new.tenant_id and contact_id = new.contact_id and is_shipping = true and deleted_at is null
        and line1 is not null and line1 !~* 'no registrad|sin direcci[oó]n|pendiente|desconocid|por definir|n/a|\yna\y'
      order by is_default desc, created_at desc
      limit 1;
      if v_address_id is null then
        raise exception 'SHIPPING_ADDRESS_REQUIRED: El pedido no tiene dirección de envío y el contacto no tiene ninguna guardada.';
      end if;
      new.shipping_address_id := v_address_id;
    end if;
  end if;

  return new;
end;
$$;
