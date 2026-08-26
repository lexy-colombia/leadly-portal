-- Carrito editable: la IA arma la cotización como siempre (create_quote) pero,
-- en vez de confirmarla ella misma, puede generar un link público a una
-- página de checkout donde el cliente revisa/edita el pedido y lo termina él
-- mismo (ver CLAUDE.md, diseño acordado 2026-08-26: "convive como opción" con
-- el cierre directo que la IA ya hace para ventas simples de un solo ítem).
-- El token (no el id de la orden) es lo único que identifica el carrito en la
-- URL pública -- unadivinable, para que nadie pueda enumerar carritos de otros
-- clientes con solo cambiar un número. Mismo patrón que sales_order_payment_links
-- (20260825190000): solo lectura para el tenant, toda escritura vía service_role.
create table public.sales_order_checkout_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  order_id uuid not null references public.sales_orders(id),
  token text not null unique default encode(extensions.gen_random_bytes(32), 'hex'),
  status text not null default 'pending' check (status in ('pending', 'completed', 'expired', 'cancelled')),
  -- null = lo generó la IA por WhatsApp; con valor = un agente humano lo
  -- generó desde el portal (mismo criterio que sales_order_payment_links.created_by,
  -- no construido todavía -- hoy el único emisor real es la IA).
  created_by uuid references public.profiles(id),
  expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sales_order_checkout_links_order_idx on public.sales_order_checkout_links (order_id);
create index sales_order_checkout_links_tenant_idx on public.sales_order_checkout_links (tenant_id);

alter table public.sales_order_checkout_links enable row level security;

create policy "tenant reads own sales order checkout links"
  on public.sales_order_checkout_links for select
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create trigger set_updated_at
  before update on public.sales_order_checkout_links
  for each row execute function public.set_updated_at();
