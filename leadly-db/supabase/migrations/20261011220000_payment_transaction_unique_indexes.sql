-- PROPUESTA, NO APLICADA (fusion del webhook de Wompi; progress/webhook_merge_report.md).
-- Cierra en la base la regla "una misma transaccion de Wompi no puede acreditar
-- dos destinos" (el receptor ya lo comprueba en TypeScript y confirma con Wompi;
-- esto es el candado final contra carreras y contra cualquier otro escritor).
--
-- ANTES de moverla a supabase/migrations/ el coordinador debe correr las consultas
-- de solo lectura del informe (seccion "Consultas de produccion") y confirmar que
-- NO hay duplicados: si los hubiera, el bloque DO aborta la migracion a proposito
-- (mejor fallar ruidosamente que dejar un candado a medias).
--
-- Idempotente. Los indices son PARCIALES:
--  * payment_invoices: solo filas con transaccion (la columna solo se llena al pasar a PAID).
--  * sales_order_payments: solo pagos de Wompi no borrados con transaccion; los pagos
--    manuales/credito no tienen provider_transaction_id.

do $$
begin
  if exists (
    select 1 from public.payment_invoices
     where provider_transaction_id is not null
     group by provider_transaction_id having count(*) > 1
  ) then
    raise exception 'payment_invoices tiene provider_transaction_id duplicado: resolver a mano antes de crear el indice unico';
  end if;
  if exists (
    select 1 from public.sales_order_payments
     where provider_transaction_id is not null and deleted_at is null and provider_key = 'wompi'
     group by provider_transaction_id having count(*) > 1
  ) then
    raise exception 'sales_order_payments tiene provider_transaction_id (wompi) duplicado: resolver a mano antes de crear el indice unico';
  end if;
end $$;

create unique index if not exists payment_invoices_provider_transaction_uidx
  on public.payment_invoices (provider_transaction_id)
  where provider_transaction_id is not null;

-- Mismo filtro que el DO de arriba (provider_key = 'wompi'): el indice y la comprobacion
-- previa cubren exactamente las mismas filas. El nombre del indice lo reconoce
-- applySalesOrderPaymentWebhookEvent para NO tratar este 23505 como "ya manejado".
create unique index if not exists sales_order_payments_wompi_transaction_uidx
  on public.sales_order_payments (provider_transaction_id)
  where provider_key = 'wompi' and provider_transaction_id is not null and deleted_at is null;
