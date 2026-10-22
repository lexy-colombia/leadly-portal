-- ST4 (Wompi unificado): la factura de plataforma referencia el link creado por el
-- servicio de pagos (payments.payment_links.id). Sin FK: payments no depende de public
-- y public no depende de payments (regla de aislamiento del esquema). ADITIVA: no toca
-- provider_checkout_id (la rama legacy aun lo lee; se retira en ST5).
alter table public.payment_invoices add column if not exists payments_link_id uuid;

create index if not exists payment_invoices_payments_link_id_idx
  on public.payment_invoices (payments_link_id)
  where payments_link_id is not null;

comment on column public.payment_invoices.payments_link_id is
  'Id del link en payments.payment_links (servicio de pagos). Sin FK a proposito.';
