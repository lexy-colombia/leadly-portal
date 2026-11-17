-- F1 / S1.3 — Método de entrega, perfil de facturación y destino congelado en
-- carts y sales_orders. Aditiva: NO elimina billing_address_id ni
-- is_billing/is_shipping (eso es F5).
--
--  * fulfillment_method: 'delivery' | 'pickup' | 'on_site'. Default 'delivery'
--    (default seguro: un insert que no lo manda, p. ej. tienda/IA/portal, sigue
--    exigiendo dirección al confirmar). POS es siempre 'on_site' (decisión
--    cerrada): un trigger lo fuerza, así el POS no se rompe aunque las Edge
--    Functions aún no manden el campo.
--  * billing_profile_id: FK compuesta (tenant, cliente del pedido, perfil): un
--    perfil de otro cliente o de otro tenant es imposible por esquema.
--  * shipping_snapshot (solo pedidos): destino congelado al confirmar.
--  * shipping_address_id: pertenencia (tenant, cliente) por trigger (sin FK nueva).
--  * sales_order_shipping_corrections: bitácora append-only de correcciones
--    de destino posteriores a la confirmación.

-- ---------------------------------------------------------------------------
-- 1. Columnas
-- ---------------------------------------------------------------------------
-- Valor por defecto constante: metadato, sin reescribir la tabla.
alter table public.carts
  add column fulfillment_method text not null default 'delivery'
    constraint carts_fulfillment_method_check check (fulfillment_method in ('delivery', 'pickup', 'on_site')),
  add column billing_profile_id uuid;

alter table public.sales_orders
  add column fulfillment_method text not null default 'delivery'
    constraint sales_orders_fulfillment_method_check check (fulfillment_method in ('delivery', 'pickup', 'on_site')),
  add column billing_profile_id uuid,
  add column shipping_snapshot jsonb
    constraint sales_orders_shipping_snapshot_object check (shipping_snapshot is null or jsonb_typeof(shipping_snapshot) = 'object');

alter table public.carts
  add constraint carts_billing_profile_needs_contact check (billing_profile_id is null or contact_id is not null);

-- ---------------------------------------------------------------------------
-- 2. POS siempre on_site (trigger) + backfill
-- ---------------------------------------------------------------------------
create or replace function public.force_pos_on_site()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'carts' then
    if new.origin = 'pos' then new.fulfillment_method := 'on_site'; end if;
  else
    if new.sales_channel = 'pos' then new.fulfillment_method := 'on_site'; end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.force_pos_on_site() from public, anon, authenticated;

create trigger carts_force_pos_on_site
  before insert or update of origin, fulfillment_method on public.carts
  for each row execute function public.force_pos_on_site();
create trigger sales_orders_force_pos_on_site
  before insert or update of sales_channel, fulfillment_method on public.sales_orders
  for each row execute function public.force_pos_on_site();

-- Backfill POS -> on_site. El UPDATE no debe mover updated_at: se apaga solo el
-- trigger de updated_at durante el backfill (los demás triggers de
-- sales_orders son "update of status" o de otras columnas y no se disparan).
alter table public.sales_orders disable trigger sales_orders_set_updated_at;
update public.sales_orders set fulfillment_method = 'on_site'
 where sales_channel = 'pos' and fulfillment_method <> 'on_site';
alter table public.sales_orders enable trigger sales_orders_set_updated_at;

alter table public.carts disable trigger carts_set_updated_at;
update public.carts set fulfillment_method = 'on_site'
 where origin = 'pos' and fulfillment_method <> 'on_site';
alter table public.carts enable trigger carts_set_updated_at;

-- ---------------------------------------------------------------------------
-- 3. Claves foráneas compuestas
-- ---------------------------------------------------------------------------
-- Perfil: mismo tenant y mismo cliente. MATCH SIMPLE: con billing_profile_id
-- nulo no se valida. Sin ON DELETE SET NULL: un perfil con pedidos no se borra
-- físicamente (se desactiva con deleted_at).
alter table public.carts
  add constraint carts_billing_profile_fkey
    foreign key (tenant_id, contact_id, billing_profile_id)
    references public.client_billing_profiles (tenant_id, client_id, id);
alter table public.sales_orders
  add constraint sales_orders_billing_profile_fkey
    foreign key (tenant_id, contact_id, billing_profile_id)
    references public.client_billing_profiles (tenant_id, client_id, id);

-- Dirección de envío: NO se crea una segunda FK sobre shipping_address_id
-- (una FK compuesta adicional sales_orders -> contact_addresses podría volver
-- ambiguo el hint `contact_addresses!shipping_address_id` de los embeds
-- PostgREST de Órdenes / list-sales-orders). La pertenencia (mismo tenant y
-- mismo cliente) la garantiza este trigger BEFORE:
--   * INSERT / UPDATE que cambia shipping_address_id, contact_id o
--     billing_profile_id: valida la pertenencia y lanza 23503 claro si no.
--   * UPDATE que cambia contact_id SIN tocar shipping_address_id /
--     billing_profile_id y que dejaría de pertenecer al nuevo cliente: los pone
--     en NULL (limpieza; el shipping_snapshot conserva el destino histórico).
--   * Si el mismo UPDATE cambia ambos y quedan inconsistentes: ERROR.
--   * Filas viejas ya inconsistentes no se tocan ni bloquean otras ediciones
--     (solo se valida cuando cambia una de las 3 columnas).
-- billing_profile_id sí lleva FK compuesta: la tabla destino es nueva y no hay
-- embeds previos que desambiguar.
create or replace function public.enforce_order_cart_links()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.shipping_address_id is not distinct from old.shipping_address_id
     and new.billing_profile_id is not distinct from old.billing_profile_id
     and new.contact_id is not distinct from old.contact_id then
    return new;
  end if;

  -- Limpieza al cambiar de cliente (columnas que el UPDATE no tocó).
  if tg_op = 'UPDATE' and new.contact_id is distinct from old.contact_id then
    if new.shipping_address_id is not null
       and new.shipping_address_id is not distinct from old.shipping_address_id
       and not exists (
         select 1 from public.contact_addresses a
          where a.id = new.shipping_address_id and a.tenant_id = new.tenant_id
            and a.contact_id is not distinct from new.contact_id) then
      new.shipping_address_id := null;
    end if;
    if new.billing_profile_id is not null
       and new.billing_profile_id is not distinct from old.billing_profile_id
       and not exists (
         select 1 from public.client_billing_profiles p
          where p.id = new.billing_profile_id and p.tenant_id = new.tenant_id
            and p.client_id is not distinct from new.contact_id) then
      new.billing_profile_id := null;
    end if;
  end if;

  -- Sin cliente no hay contra qué validar (carritos sin contacto).
  if new.shipping_address_id is not null and new.contact_id is not null
     and not exists (
       select 1 from public.contact_addresses a
        where a.id = new.shipping_address_id and a.tenant_id = new.tenant_id and a.contact_id = new.contact_id) then
    raise exception 'SHIPPING_ADDRESS_OWNER: la dirección de envío % no pertenece al cliente % de este tenant.', new.shipping_address_id, new.contact_id
      using errcode = '23503', constraint = 'shipping_address_owner';
  end if;
  return new;
end;
$$;
revoke execute on function public.enforce_order_cart_links() from public, anon, authenticated;

create trigger carts_enforce_links
  before insert or update of shipping_address_id, contact_id, billing_profile_id on public.carts
  for each row execute function public.enforce_order_cart_links();
create trigger sales_orders_enforce_links
  before insert or update of shipping_address_id, contact_id, billing_profile_id on public.sales_orders
  for each row execute function public.enforce_order_cart_links();

-- ---------------------------------------------------------------------------
-- 4. Índices
-- ---------------------------------------------------------------------------
create index carts_billing_profile_idx on public.carts (billing_profile_id) where billing_profile_id is not null;
create index sales_orders_billing_profile_idx on public.sales_orders (billing_profile_id) where billing_profile_id is not null;
create index sales_orders_fulfillment_method_idx on public.sales_orders (tenant_id, fulfillment_method);

-- ---------------------------------------------------------------------------
-- 5. Correcciones de destino (append-only)
-- ---------------------------------------------------------------------------
alter table public.sales_orders
  add constraint sales_orders_tenant_id_id_key unique (tenant_id, id);

create table public.sales_order_shipping_corrections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null,
  corrected_by uuid references public.profiles(id) on delete set null,
  corrected_at timestamptz not null default now(),
  reason text not null check (length(btrim(reason)) > 0),
  previous_shipping_address_id uuid,
  previous_shipping_snapshot jsonb,
  new_shipping_address_id uuid,
  new_shipping_snapshot jsonb,
  constraint sales_order_shipping_corrections_order_fkey
    foreign key (tenant_id, order_id) references public.sales_orders (tenant_id, id) on delete cascade
);

comment on table public.sales_order_shipping_corrections is
  'Bitácora append-only de correcciones del destino de un pedido ya confirmado: quién, cuándo, por qué y el valor anterior.';

create index sales_order_shipping_corrections_order_idx on public.sales_order_shipping_corrections (tenant_id, order_id, corrected_at desc);
create index sales_order_shipping_corrections_corrected_by_idx on public.sales_order_shipping_corrections (corrected_by) where corrected_by is not null;

alter table public.sales_order_shipping_corrections enable row level security;
create policy sales_order_shipping_corrections_select on public.sales_order_shipping_corrections
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
-- corrected_by = auth.uid(): nadie puede registrar una corrección a nombre de
-- otro. El permiso (sales.correct_shipping) se exige en la Edge Function (F2),
-- que escribe con service_role; esta policy solo cubre la escritura directa.
create policy sales_order_shipping_corrections_insert on public.sales_order_shipping_corrections
  for insert with check (
    (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    and corrected_by = auth.uid());
-- Sin policies de update/delete a propósito (ledger, igual que stock_movements).
revoke all on public.sales_order_shipping_corrections from anon;
