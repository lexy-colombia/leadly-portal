-- Módulo de direcciones (pedido explícito del usuario): libreta de
-- direcciones por contacto, reutilizable entre cotizaciones/ventas, para
-- saber a dónde despachar el pedido y qué datos de facturación usar. Una
-- misma fila puede servir para envío y/o facturación (is_shipping/
-- is_billing, no un enum rígido) porque en la práctica suele ser la misma
-- dirección para ambas cosas. Mismo patrón soft-delete que el resto del CRM.
create table public.crm_contact_addresses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  label text,
  is_shipping boolean not null default true,
  is_billing boolean not null default false,
  recipient_name text,
  phone text,
  tax_id text,
  line1 text not null,
  line2 text,
  city text,
  state_province text,
  postal_code text,
  country text default 'Colombia',
  notes text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index crm_contact_addresses_tenant_id_idx on public.crm_contact_addresses(tenant_id);
create index crm_contact_addresses_contact_id_idx on public.crm_contact_addresses(contact_id);

create trigger crm_contact_addresses_set_updated_at
  before update on public.crm_contact_addresses
  for each row execute function public.set_updated_at();

alter table public.crm_contact_addresses enable row level security;

create policy crm_contact_addresses_select on public.crm_contact_addresses
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_contact_addresses_insert on public.crm_contact_addresses
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_contact_addresses_update on public.crm_contact_addresses
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_contact_addresses_delete on public.crm_contact_addresses
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_contact_addresses from anon;

-- Une una cotización/venta a la dirección de envío y/o facturación elegida
-- (ambas nullable -- una orden puede no necesitar envío físico, ej. algo
-- digital, o no tener todavía una dirección capturada).
alter table public.crm_orders
  add column shipping_address_id uuid references public.crm_contact_addresses(id) on delete set null,
  add column billing_address_id uuid references public.crm_contact_addresses(id) on delete set null;
