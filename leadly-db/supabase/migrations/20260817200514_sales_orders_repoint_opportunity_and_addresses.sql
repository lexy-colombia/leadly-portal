-- Repuntea las 3 FKs de sales_orders que quedaron sin constraint tras el
-- drop de crm_opportunities/crm_contact_addresses (20260817020001, cascade).
-- Los datos ya son compatibles: opportunities/contact_addresses son las
-- tablas destino reales desde el cutover, y al momento de aplicar esto no
-- había ninguna fila de sales_orders con estas columnas seteadas
-- (verificado antes de aplicar), así que no hubo riesgo de violar la
-- constraint nueva con datos huérfanos.

alter table public.sales_orders
  add constraint sales_orders_opportunity_id_fkey
    foreign key (opportunity_id) references public.opportunities(id) on delete set null;

alter table public.sales_orders
  add constraint sales_orders_shipping_address_id_fkey
    foreign key (shipping_address_id) references public.contact_addresses(id) on delete set null;

alter table public.sales_orders
  add constraint sales_orders_billing_address_id_fkey
    foreign key (billing_address_id) references public.contact_addresses(id) on delete set null;
