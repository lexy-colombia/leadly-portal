-- Encontrado en vivo el 2026-08-24: confirm_quote (whatsapp-ai-tools) valida
-- que haya stock suficiente antes de confirmar una venta, pero nunca lo
-- reserva -- ni siquiera existía un movement_type usable, ya que 'reserva'/
-- 'liberacion_reserva' ya estaban soportados por apply_stock_movement()
-- (ver 20260816000002_stock_buckets.sql) pero reference_type no tenía
-- ningún valor que describiera "reservado por una venta confirmada".
-- Decisión explícita del usuario: confirmar una cotización reserva stock
-- (reserved_quantity sube, quantity físico baja) pero no lo descuenta del
-- todo -- el descuento definitivo sigue pasando recién en el despacho real
-- (salida_despacho ya libera la reserva y mueve a departure_quantity, sin
-- cambios necesarios ahí).
alter table public.stock_movements drop constraint stock_movements_reference_type_check;
alter table public.stock_movements add constraint stock_movements_reference_type_check
  check (reference_type = any (array['carga_inicial', 'compra', 'despacho', 'ajuste_manual', 'transferencia', 'devolucion', 'venta']));

update public.ai_skills set
  prompt_fragment = replace(
    prompt_fragment,
    'confirm_quote(): sin parámetros. Pasa el pedido de "cotizacion" a "confirmada" y descuenta el inventario real (de la variante específica, si aplica); puede fallar por stock insuficiente.',
    'confirm_quote(): sin parámetros. Pasa el pedido de "cotizacion" a "confirmada" y reserva el stock real (de la variante específica, si aplica) contra la bodega principal del tenant -- puede fallar por stock insuficiente. La reserva no es el descuento final: eso sigue pasando recién cuando el pedido se despacha de verdad.'
  )
where key = 'ventas';
