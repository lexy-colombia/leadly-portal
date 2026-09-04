-- Hoy no existe ningún concepto de "por dónde se creó este pedido" --
-- created_by/opportunity_id son las únicas señales indirectas. Esta
-- columna sirve tanto para reporting como para que el trigger de
-- confirmación sepa cuándo saltarse el requisito de direcciones (ver
-- pos_guard_confirmation_skip_address).
alter table public.sales_orders add column sales_channel text
  check (sales_channel in ('pos', 'whatsapp', 'storefront', 'portal'));
create index sales_orders_sales_channel_idx on public.sales_orders(sales_channel) where sales_channel is not null;
