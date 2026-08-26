-- Pedido explícito del usuario: quitar "Otro" como método de pago
-- seleccionable, tanto en pagos de ventas (sales_order_payments) como en
-- pagos de cartera/crédito (credit_payments). Cero filas existentes usaban
-- 'otro' en ninguna de las dos tablas (verificado antes de aplicar), así
-- que no hay datos históricos que reclasificar.

alter table public.sales_order_payments
  drop constraint sales_order_payments_method_check,
  add constraint sales_order_payments_method_check
    check (method = any (array['efectivo', 'transferencia', 'tarjeta', 'credito', 'saldo_favor', 'wompi']));

alter table public.credit_payments
  drop constraint credit_payments_method_check,
  add constraint credit_payments_method_check
    check (method = any (array['efectivo', 'transferencia', 'tarjeta']));
