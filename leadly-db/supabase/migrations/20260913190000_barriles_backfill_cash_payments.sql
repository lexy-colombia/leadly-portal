-- Barriles de la sexta: registra el pago en efectivo de las ventas de
-- septiembre que quedaron sin ningún pago cargado.
--
-- Pedido explícito del usuario (2026-09-13): "a los pedidos de esa empresa,
-- el que no tenga pagos, ponle pagos en efectivo desde el 1 de septiembre en
-- adelante, para que no me salgan órdenes sin pago en esas fechas". Son
-- ventas de mostrador ya cobradas en su momento; lo que falta es el registro
-- del pago, no la plata.
--
-- Alcance, deliberadamente acotado:
-- - solo el tenant Barriles de la sexta (id explícito: es una reparación de
--   datos puntual de UN comercio, no una regla de la plataforma);
-- - desde el 2026-09-01 en hora de Colombia;
-- - solo ventas CONFIRMADAS y no anuladas -- una cotización todavía no se
--   cobró y una venta anulada no se cobra nunca;
-- - solo las que hoy no tienen NINGÚN pago vivo (un pago parcial se deja
--   como está: no es "sin pagos", y completarlo sería inventar un monto);
-- - solo total > 0 -- hay 4 pedidos en $0 y un pago en efectivo de $0 no
--   existe; esos además ya no muestran saldo pendiente.
--
-- El monto es el total del pedido y la fecha del pago es el día de la venta
-- (hora Colombia), para que el pago caiga en el mismo día que la venta en
-- los informes. `created_by` queda null a propósito: no lo registró una
-- persona desde la app, fue esta reparación.
--
-- Idempotente: el `not exists` hace que una segunda corrida no duplique nada.
-- Los triggers de inserción de pagos (crédito y saldo a favor) salen sin
-- hacer nada cuando el método no es el suyo, así que 'efectivo' no dispara
-- ningún efecto colateral.

insert into public.sales_order_payments (tenant_id, order_id, method, amount, currency, paid_at, notes)
select
  o.tenant_id,
  o.id,
  'efectivo',
  o.total,
  o.currency,
  (o.created_at at time zone 'America/Bogota')::date,
  'Pago registrado por conciliación de ventas de septiembre (venta de mostrador ya cobrada, sin registro del pago).'
from public.sales_orders o
where o.tenant_id = '9c79437d-1c19-4edc-bc1f-0dc06094823a'
  and o.created_at >= timestamptz '2026-09-01 00:00:00-05'
  and o.status = 'confirmada'
  and o.deleted_at is null
  and o.total > 0
  and not exists (
    select 1 from public.sales_order_payments p
    where p.order_id = o.id and p.deleted_at is null
  );
