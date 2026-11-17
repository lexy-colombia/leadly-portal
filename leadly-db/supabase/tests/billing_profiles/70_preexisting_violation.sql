set client_min_messages = warning;
do $$
declare r text;
begin
  perform t.ok('V1 una fila preexistente con direccion de OTRO cliente NO aborta la migracion (el trigger solo valida cambios)',
    (select count(*) from public.sales_orders where contact_id = t.id('c_other') and shipping_address_id = t.id('a_ship')) = 1);
  r := t.try(format($q$insert into public.sales_orders(tenant_id, contact_id, sales_channel, shipping_address_id) values (%L, %L, 'portal', %L)$q$, t.id('A'), t.id('c_full'), t.id('a_other')));
  perform t.ok('V2 escrituras NUEVAS inconsistentes siguen rechazadas', r like '23503%', r);
  r := t.try(format($q$update public.sales_orders set notes = 'tocar otra columna' where contact_id = %L and shipping_address_id = %L$q$, t.id('c_other'), t.id('a_ship')));
  perform t.ok('V3 actualizar OTRAS columnas del pedido ya inconsistente sigue funcionando', r = 'ok', r);
  r := t.try(format($q$update public.sales_orders set shipping_address_id = shipping_address_id, contact_id = contact_id where contact_id = %L and shipping_address_id = %L$q$, t.id('c_other'), t.id('a_ship')));
  perform t.ok('V3b reenviar los mismos valores (sin cambio real) tampoco falla', r = 'ok', r);
end $$;
