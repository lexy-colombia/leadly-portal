-- Borra carritos abiertos sin actividad hace más de 7 días -- portal y
-- POS por igual (un "Crear pedido" nunca clickeado en el portal, o una
-- cuenta de POS que nadie canceló a mano). Cascada a cart_items.
create or replace function public.cleanup_abandoned_carts() returns void
language sql security definer set search_path = public as $$
  delete from public.carts where status = 'open' and last_activity_at < now() - interval '7 days';
$$;
revoke execute on function public.cleanup_abandoned_carts() from public, anon, authenticated;

select cron.schedule(
  'cleanup_abandoned_carts_daily',
  '0 4 * * *',
  $$select public.cleanup_abandoned_carts();$$
);
