-- Puente entre un pedido (sales_orders) y un cobro real de Wompi. Hasta hoy
-- generate_payment_link (whatsapp-ai-tools) ya creaba un link de pago real
-- contra la cuenta de Wompi del propio tenant, pero no quedaba ningún rastro
-- que permitiera que payment-webhook-wompi supiera a qué pedido aplicar el
-- pago cuando el cliente pagara -- el link vivía y moría sin tocar
-- sales_order_payments. Esta tabla es ese rastro: se crea una fila al
-- generar el link (pendiente), y el webhook la resuelve por
-- provider_checkout_id cuando llega el evento de Wompi.

create table public.sales_order_payment_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  order_id uuid not null references public.sales_orders(id),
  provider_key text not null,
  provider_checkout_id text not null,
  checkout_url text not null,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'COP',
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'cancelled')),
  -- null = lo generó la IA por WhatsApp; con valor = un agente humano lo
  -- generó desde el detalle del pedido (create-sales-order-payment-link).
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index sales_order_payment_links_provider_checkout_idx
  on public.sales_order_payment_links (provider_key, provider_checkout_id);
create index sales_order_payment_links_order_idx on public.sales_order_payment_links (order_id);
create index sales_order_payment_links_tenant_idx on public.sales_order_payment_links (tenant_id);

alter table public.sales_order_payment_links enable row level security;

-- Solo lectura para el propio tenant (ver el estado de un link ya generado
-- desde la UI a futuro) -- toda escritura pasa por service_role
-- (whatsapp-ai-tools, create-sales-order-payment-link, payment-webhook-wompi),
-- nunca directo desde el cliente.
create policy "tenant reads own sales order payment links"
  on public.sales_order_payment_links for select
  using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create trigger set_updated_at
  before update on public.sales_order_payment_links
  for each row execute function public.set_updated_at();

-- sales_order_payments gana los campos para registrar un pago de Wompi tal
-- cual: método propio ('wompi', no lo fuerces dentro de 'tarjeta' porque
-- Wompi también cubre PSE/Nequi/Bancolombia), y el detalle que vuelve del
-- webhook. payment_link_id es la referencia de vuelta a la fila de arriba
-- -- su índice único evita registrar el mismo pago dos veces si Wompi
-- reintenta la entrega del webhook.
alter table public.sales_order_payments
  drop constraint sales_order_payments_method_check,
  add constraint sales_order_payments_method_check
    check (method = any (array['efectivo', 'transferencia', 'tarjeta', 'otro', 'credito', 'saldo_favor', 'wompi'])),
  add column provider_key text,
  add column provider_transaction_id text,
  add column provider_reference text,
  add column payment_link_id uuid references public.sales_order_payment_links(id);

create unique index sales_order_payments_payment_link_idx
  on public.sales_order_payments (payment_link_id)
  where payment_link_id is not null;
