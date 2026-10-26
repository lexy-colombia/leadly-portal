-- Backfill (se ejecuta DESPUES de aplicar la migracion sobre una base que ya tenia cuentas POS abiertas).
set client_min_messages = warning;
do $$
begin
  perform t.chk('K1 backfill: la cuenta POS mas antigua conserva su reserva completa (3)', t.resv('kb_old') = 3, 'resv=' || t.resv('kb_old'));
  perform t.chk('K2 backfill: la cuenta nueva sin stock suficiente reserva solo lo que queda (2 de 4)', t.resv('kb_new') = 2, 'resv=' || t.resv('kb_new'));
  perform t.chk('K3 backfill: nunca reserva mas que el fisico (5)', t.resv('kb_old') + t.resv('kb_new') <= 5);
  perform t.chk('K4 backfill: cuentas storefront/portal abiertas no reservan', t.resv('kb_sf') = 0 and t.resv('kb_portal') = 0);
  perform t.chk('K5 backfill: carrito cerrado no reserva', t.resv('kb_closed') = 0);
  perform t.chk('K6 el backfill no altera lineas ni stock fisico', (select count(*) from public.cart_items where cart_id = t.id('kb_new')) = 1 and t.phys('pkb') = 5);
  perform t.expect_error('K7 la cuenta con linea sin stock rechaza una edicion que pida mas (como el POS de hoy)', format('select t.save(%L, %L, jsonb_build_array(t.line(%L, 4)))', 'kb_new', 'tkb', 'pkb'), '%Sin stock suficiente%', 'LX422');
  perform t.save('kb_new', 'tkb', jsonb_build_array(t.line('pkb', 2)));
  perform t.chk('K8 quitar la linea sin stock (bajar a lo reservado) si se puede guardar', t.resv('kb_new') = 2);
end $$;
