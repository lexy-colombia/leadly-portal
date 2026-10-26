set client_min_messages = warning;

-- ============ A. Dos cajas y la ultima unidad ============
do $$
declare a numeric; v_msg text; v_state text; v_detail text; n int;
begin
  perform t.tenant('ta'); perform t.product('pa', 'ta', 1);
  perform t.cart('ca1', 'ta'); perform t.cart('ca2', 'ta');
  perform t.chk('A1 disponible inicial = fisico (1)', t.avail('pa', 'ta') = 1);
  perform t.save('ca1', 'ta', jsonb_build_array(t.line('pa', 1)));
  perform t.chk('A2 caja 1 reserva la ultima unidad', t.resv('ca1') = 1);
  perform t.chk('A3 el fisico NO se descuenta al cargar', t.phys('pa') = 1);
  perform t.chk('A4 disponible para OTRO carrito = 0', t.avail('pa', 'ta', null, t.id('ca2')) = 0);
  perform t.chk('A5 disponible excluyendo el propio carrito = 1', t.avail('pa', 'ta', null, t.id('ca1')) = 1);
  begin
    perform t.save('ca2', 'ta', jsonb_build_array(t.line('pa', 1)));
    perform t.chk('A6 caja 2 rechazada (LX422)', false, 'no fallo');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_detail = pg_exception_detail; v_msg := sqlerrm;
    perform t.chk('A6 caja 2 rechazada con LX422', v_state = 'LX422', v_state || ' ' || v_msg);
    perform t.chk('A7 mensaje con nombre, disponible y pedido', v_msg like '%"pa" (disponible 0, pedido 1)%', v_msg);
    perform t.chk('A8 DETAIL es JSON con available/requested', (v_detail::jsonb -> 0 ->> 'available')::numeric = 0 and (v_detail::jsonb -> 0 ->> 'requested')::numeric = 1, v_detail);
  end;
  select count(*) into n from public.cart_items where cart_id = t.id('ca2');
  perform t.chk('A9 la linea rechazada no se cargo (carrito 2 sin lineas)', n = 0);
  perform t.chk('A10 la reserva de la caja 1 sigue intacta', t.resv('ca1') = 1 and t.resv('ca2') = 0);
  -- B. quitar linea
  perform t.save('ca1', 'ta', '[]'::jsonb);
  perform t.chk('B1 quitar la linea libera la reserva', t.resv('ca1') = 0 and t.avail('pa', 'ta') = 1);
  perform t.save('ca2', 'ta', jsonb_build_array(t.line('pa', 1)));
  perform t.chk('B2 la otra caja ya puede reservarla', t.resv('ca2') = 1);
  -- reducir cantidad
  perform t.product('pb', 'ta', 10);
  perform t.save('ca1', 'ta', jsonb_build_array(t.line('pb', 6)));
  perform t.chk('B3 reserva 6 de 10 -> disponible 4', t.avail('pb', 'ta') = 4);
  perform t.save('ca1', 'ta', jsonb_build_array(t.line('pb', 2)));
  perform t.chk('B4 bajar a 2 libera la diferencia (disponible 8)', t.avail('pb', 'ta') = 8 and t.resv('ca1') = 2);
  -- guardar de nuevo lo mismo no falla ni duplica
  perform t.save('ca1', 'ta', jsonb_build_array(t.line('pb', 2)));
  perform t.chk('B5 guardado repetido idempotente', t.resv('ca1') = 2 and (select count(*) from public.stock_reservations where cart_id = t.id('ca1')) = 1);
  -- lineas repetidas del mismo producto se suman
  perform t.save('ca1', 'ta', jsonb_build_array(t.line('pb', 2), t.line('pb', 3)));
  perform t.chk('B6 lineas repetidas del mismo producto reservan la suma (5)', t.resv('ca1') = 5);
  -- subir sin stock suficiente
  perform t.expect_error('B7 subir mas de lo disponible falla', format('select t.save(%L, %L, jsonb_build_array(t.line(%L, 11)))', 'ca1', 'ta', 'pb'), '%Sin stock suficiente%', 'LX422');
  perform t.chk('B8 tras el fallo el carrito conserva su estado previo (5)', t.resv('ca1') = 5 and (select count(*) from public.cart_items where cart_id = t.id('ca1')) = 2);
end $$;

-- ============ C. Cerrar / cancelar / borrar el carrito ============
do $$
declare cid uuid;
begin
  perform t.tenant('tc'); perform t.product('pc', 'tc', 5);
  perform t.cart('cc1', 'tc'); perform t.cart('cc2', 'tc'); perform t.cart('cc3', 'tc');
  perform t.save('cc1', 'tc', jsonb_build_array(t.line('pc', 1)));
  perform t.save('cc2', 'tc', jsonb_build_array(t.line('pc', 1)));
  perform t.save('cc3', 'tc', jsonb_build_array(t.line('pc', 1)));
  perform t.chk('C0 tres cuentas reservan 3 de 5', t.avail('pc', 'tc') = 2);
  update public.carts set status = 'converted' where id = t.id('cc1');
  perform t.chk('C1 cerrar la cuenta (status converted) libera', t.resv('cc1') = 0 and t.avail('pc', 'tc') = 3);
  delete from public.carts where id = t.id('cc2');
  perform t.chk('C2 borrar el carrito libera (cascada)', t.resv('cc2') = 0 and t.avail('pc', 'tc') = 4);
  perform t.expect_error('C3 guardar un carrito cerrado sigue dando LX409', format('select t.save(%L, %L, ''[]''::jsonb)', 'cc1', 'tc'), '%ya no est%', 'LX409');
  perform t.expect_error('C4 carrito de otro tenant sigue dando LX404', format('select public.save_cart_lines(%L, %L, ''{}''::jsonb, ''[]''::jsonb)', t.id('cc3'), gen_random_uuid()), '%no encontrado%', 'LX404');
  -- borrar la linea con DELETE directo (camino de la tienda) libera
  delete from public.cart_items where cart_id = t.id('cc3');
  perform t.chk('C5 DELETE directo de la linea libera', t.resv('cc3') = 0 and t.avail('pc', 'tc') = 5);
end $$;

-- ============ D. Convertir en venta sin doble descuento ============
do $$
declare oid uuid; wh uuid; mv int; o2 uuid;
begin
  perform t.tenant('td'); perform t.product('pd', 'td', 5);
  wh := t.id('td_w1');
  perform t.cart('cd1', 'td'); perform t.cart('cd2', 'td');
  perform t.save('cd1', 'td', jsonb_build_array(t.line('pd', 5)));
  perform t.chk('D0 la cuenta reserva las 5 unidades', t.avail('pd', 'td') = 0);
  -- el flujo de create-order: pedido en cotizacion con cart_id + items, luego confirmar
  insert into public.sales_orders(tenant_id, status, sales_channel) values (t.id('td'), 'cotizacion', 'pos') returning id into oid;
  update public.sales_orders set cart_id = t.id('cd1') where id = oid;
  insert into public.sales_order_items(order_id, product_id, product_name, quantity) values (oid, t.id('pd'), 'pd', 5);
  update public.sales_orders set status = 'confirmada' where id = oid;
  perform t.chk('D1 el fisico baja UNA vez (5 -> 0)', t.phys('pd') = 0);
  perform t.chk('D2 la reserva se consumio en la confirmacion', t.resv('cd1') = 0);
  select count(*) into mv from public.stock_movements where reference_id = oid and movement_type = 'salida';
  perform t.chk('D3 un solo movimiento de salida', mv = 1);
  perform t.chk('D4 disponible = fisico = 0 (sin doble descuento)', t.avail('pd', 'td') = 0);
  -- cerrar el carrito despues no cambia nada
  delete from public.cart_items where cart_id = t.id('cd1');
  update public.carts set status = 'converted', converted_order_id = oid where id = t.id('cd1');
  perform t.chk('D5 cerrar tras el cobro no altera stock ni reservas', t.phys('pd') = 0 and t.resv('cd1') = 0);
  -- cancelacion posterior: vuelve el stock una vez
  update public.sales_orders set status = 'cancelada' where id = oid;
  perform t.chk('D6 cancelar devuelve el fisico (0 -> 5)', t.phys('pd') = 5);
  perform t.chk('D7 tras cancelar no hay reservas y disponible = 5', t.avail('pd', 'td') = 5 and (select count(*) from public.stock_reservations where tenant_id = t.id('td')) = 0);

  -- cobro PARCIAL: cuenta de 5, se cobran 2
  perform t.product('pe', 'td', 10);
  perform t.save('cd2', 'td', jsonb_build_array(t.line('pe', 5)));
  insert into public.sales_orders(tenant_id, status, sales_channel) values (t.id('td'), 'cotizacion', 'pos') returning id into o2;
  update public.sales_orders set cart_id = t.id('cd2') where id = o2;
  insert into public.sales_order_items(order_id, product_id, product_name, quantity) values (o2, t.id('pe'), 'pe', 2);
  update public.sales_orders set status = 'confirmada' where id = o2;
  perform t.chk('D8 cobro parcial: fisico 10 -> 8', t.phys('pe') = 8);
  perform t.chk('D9 cobro parcial: quedan 3 reservadas', t.resv('cd2') = 3);
  -- create-order baja la cantidad de la linea a 3 (UPDATE directo): sin cambio ni error
  update public.cart_items set quantity = 3 where cart_id = t.id('cd2');
  perform t.chk('D10 tras bajar la linea a 3 la reserva sigue en 3', t.resv('cd2') = 3);
  perform t.chk('D11 disponible = 8 - 3 = 5 (sin doble conteo)', t.avail('pe', 'td') = 5);
  -- cobro del resto + cierre
  delete from public.cart_items where cart_id = t.id('cd2');
  perform t.chk('D12 al cobrar el resto no queda reserva', t.resv('cd2') = 0);
end $$;

-- ============ E. Tienda publica: vencimiento, abandono, renovacion ============
do $$
declare ex timestamptz; ex2 timestamptz; n int; ab timestamptz;
begin
  perform t.tenant('te'); perform t.product('pe1', 'te', 3); perform t.product('pe2', 'te', 5);
  perform t.cart('ce1', 'te', 'storefront'); perform t.cart('ce2', 'te', 'storefront');
  -- ruta de la tienda: INSERT directo en cart_items (no pasa por save_cart_lines)
  insert into public.cart_items(cart_id, product_id, product_name, quantity, unit_price) values (t.id('ce1'), t.id('pe1'), 'pe1', 3, 100);
  select expires_at into ex from public.stock_reservations where cart_id = t.id('ce1');
  perform t.chk('E1 la tienda reserva por INSERT directo', t.resv('ce1') = 3 and t.avail('pe1', 'te') = 0);
  perform t.chk('E2 vence a ~15 min', ex > now() + interval '14 minutes' and ex <= now() + interval '15 minutes 1 second', ex::text);
  perform t.expect_error('E3 segundo visitante no puede agregar lo reservado',
    format('insert into public.cart_items(cart_id, product_id, product_name, quantity, unit_price) values (%L, %L, ''pe1'', 1, 100)', t.id('ce2'), t.id('pe1')), '%Sin stock suficiente%', 'LX422');
  perform t.chk('E4 la linea rechazada no se inserto', (select count(*) from public.cart_items where cart_id = t.id('ce2')) = 0);
  -- renovacion deslizante: forzar vencimiento cercano y tocar OTRA linea
  insert into public.cart_items(cart_id, product_id, product_name, quantity, unit_price) values (t.id('ce1'), t.id('pe2'), 'pe2', 1, 100);
  update public.stock_reservations set expires_at = now() + interval '1 minute' where cart_id = t.id('ce1');
  update public.cart_items set quantity = 2 where cart_id = t.id('ce1') and product_id = t.id('pe2');
  select min(expires_at) into ex2 from public.stock_reservations where cart_id = t.id('ce1');
  perform t.chk('E5 editar una linea renueva TODAS las reservas del carrito (>14 min)', ex2 > now() + interval '14 minutes', ex2::text);
  -- vencimiento: reservas en el pasado dejan de contar de inmediato (sin esperar al cron)
  update public.stock_reservations set expires_at = now() - interval '1 second' where cart_id = t.id('ce1');
  perform t.chk('E6 reserva vencida ya no resta disponible (sin cron)', t.avail('pe1', 'te') = 3 and t.avail('pe2', 'te') = 5);
  -- la otra persona toma el stock
  insert into public.cart_items(cart_id, product_id, product_name, quantity, unit_price) values (t.id('ce2'), t.id('pe1'), 'pe1', 3, 100);
  perform t.chk('E7 el segundo visitante ahora si reserva', t.resv('ce2') = 3);
  -- cron
  select public.expire_storefront_reservations() into n;
  perform t.chk('E8 el job elimina las reservas vencidas y cuenta 1 carrito', n = 1 and t.resv('ce1') = 0, 'n=' || n);
  select abandoned_at into ab from public.carts where id = t.id('ce1');
  perform t.chk('E9 se marca el abandono del carrito', ab is not null);
  perform t.chk('E10 carrito y lineas se conservan', (select count(*) from public.cart_items where cart_id = t.id('ce1')) = 2 and (select status from public.carts where id = t.id('ce1')) = 'open');
  perform t.chk('E11 el job no toca carritos vigentes (ce2 sigue reservado y sin abandono)', t.resv('ce2') = 3 and (select abandoned_at from public.carts where id = t.id('ce2')) is null);
  -- el visitante vuelve: re-reservar puede fallar si ya no hay stock
  perform t.expect_error('E12 al volver, re-reservar falla si el stock ya lo tomo otro', format('select public.sync_cart_reservations(%L)', t.id('ce1')), '%Sin stock suficiente%', 'LX422');
  -- libera el otro y vuelve a reservar: limpia abandoned_at
  delete from public.cart_items where cart_id = t.id('ce2');
  perform public.sync_cart_reservations(t.id('ce1'));
  perform t.chk('E13 re-reserva ok cuando hay stock y limpia abandoned_at', t.resv('ce1') = 5 and (select abandoned_at from public.carts where id = t.id('ce1')) is null, 'resv=' || t.resv('ce1'));
  -- POS no vence
  perform t.cart('cp1', 'te', 'pos');
  perform t.save('cp1', 'te', jsonb_build_array(jsonb_build_object('product_id', t.id('pe2'), 'product_name', 'pe2', 'quantity', 0.5, 'unit_price', 1)));
  perform t.chk('E14 POS/mesas: expires_at null', (select expires_at from public.stock_reservations where cart_id = t.id('cp1')) is null);
  perform public.expire_storefront_reservations();
  perform t.chk('E15 el job no toca reservas sin vencimiento', t.resv('cp1') = 0.5);
end $$;

-- ============ F. Variantes, bodegas y casos que no reservan ============
do $$
declare va uuid; vb uuid; w2 uuid; pid uuid; r record;
begin
  perform t.tenant('tf'); w2 := t.wh2('tf');
  -- producto con variantes
  insert into public.products(tenant_id, name, has_variants) values (t.id('tf'), 'pv', true) returning id into pid;
  insert into t.ids values ('pv', pid);
  insert into public.product_variants(tenant_id, product_id, name) values (t.id('tf'), pid, 'A') returning id into va;
  insert into public.product_variants(tenant_id, product_id, name) values (t.id('tf'), pid, 'B') returning id into vb;
  perform t.setstock('pv', t.id('tf_w1'), 2, va);
  perform t.setstock('pv', t.id('tf_w1'), 5, vb);
  perform t.cart('cf1', 'tf'); perform t.cart('cf2', 'tf');
  perform t.save('cf1', 'tf', jsonb_build_array(t.line('pv', 2, null, va)));
  perform t.chk('F1 variante A reservada (2)', public.stock_available(t.id('tf'), pid, va) = 0 and public.stock_available(t.id('tf'), pid, vb) = 5);
  perform t.expect_error('F2 otra caja no puede reservar variante A', format('select t.save(%L, %L, jsonb_build_array(t.line(%L, 1, null, %L)))', 'cf2', 'tf', 'pv', va), '%Sin stock suficiente%', 'LX422');
  perform t.save('cf2', 'tf', jsonb_build_array(t.line('pv', 1, null, vb)));
  perform t.chk('F3 la variante B sigue disponible e independiente', public.stock_available(t.id('tf'), pid, vb) = 4);
  -- linea de producto con variantes SIN variante elegida: no reserva ni rechaza
  perform t.save('cf2', 'tf', jsonb_build_array(t.line('pv', 99)));
  perform t.chk('F4 producto con variantes sin variante elegida: no reserva ni rechaza', t.resv('cf2') = 0);
  -- bodega nula = bodega por defecto
  perform t.product('pw', 'tf', 4);          -- 4 en W1 (default)
  perform t.setstock('pw', w2, 6);           -- 6 en W2
  perform t.cart('cf3', 'tf');
  perform t.save('cf3', 'tf', jsonb_build_array(t.line('pw', 3)));
  select * into r from public.stock_reservations where cart_id = t.id('cf3');
  perform t.chk('F5 linea sin bodega se reserva en la bodega por defecto', r.warehouse_id = t.id('tf_w1') and r.quantity = 3);
  perform t.expect_error('F6b pedir 8 sin bodega (total 10, reservado 3 por otra cuenta) falla',
     format('select t.save(%L, %L, jsonb_build_array(t.line(%L, 8)))', 'cf1', 'tf', 'pw'), '%Sin stock suficiente%', 'LX422');
  perform t.save('cf1', 'tf', jsonb_build_array(t.line('pw', 7)));
  perform t.chk('F7 pedir 7 sin bodega pasa (10 - 3 reservado)', t.resv('cf1') = 7);
  -- bodega explicita se chequea por bodega
  perform t.expect_error('F8 bodega explicita W2 pide 7 (hay 6) falla',
     format('select t.save(%L, %L, jsonb_build_array(t.line(%L, 7, %L)))', 'cf2', 'tf', 'pw', w2), '%Sin stock suficiente%', 'LX422');
  perform t.save('cf2', 'tf', jsonb_build_array(t.line('pw', 3, w2)));
  perform t.chk('F9 bodega explicita W2 pide 3 pasa', (select quantity from public.stock_reservations where cart_id = t.id('cf2') and warehouse_id = w2) = 3);
  -- no rastreado
  perform t.product('pn', 'tf', 0, false);
  perform t.save('cf2', 'tf', jsonb_build_array(t.line('pn', 50)));
  perform t.chk('F10 track_inventory=false no reserva ni rechaza', t.resv('cf2') = 0);
  -- sin product_id (linea libre)
  perform t.save('cf2', 'tf', jsonb_build_array(jsonb_build_object('product_name', 'libre', 'quantity', 3, 'unit_price', 5)));
  perform t.chk('F11 linea sin producto no reserva', t.resv('cf2') = 0);
  -- sin bodega por defecto: linea sin bodega se omite
  perform t.tenant('tf2'); perform t.product('px', 'tf2', 5); update public.warehouses set is_default = false where tenant_id = t.id('tf2');
  perform t.cart('cf4', 'tf2'); perform t.save('cf4', 'tf2', jsonb_build_array(t.line('px', 1)));
  perform t.chk('F12 tenant sin bodega por defecto: linea sin bodega no reserva ni rompe', t.resv('cf4') = 0);
  -- carrito portal no reserva
  perform t.cart('cf5', 'tf', 'portal');
  perform t.save('cf5', 'tf', jsonb_build_array(t.line('pw', 1)));
  perform t.chk('F13 carrito portal (borrador de Ordenes) no reserva', t.resv('cf5') = 0);
end $$;

-- ============ G. Aislamiento entre tenants ============
do $$
declare uid_b uuid := gen_random_uuid(); uid_a uuid := gen_random_uuid(); n int;
begin
  perform t.tenant('tg_a'); perform t.tenant('tg_b');
  perform t.product('pga', 'tg_a', 5); perform t.product('pgb', 'tg_b', 5);
  perform t.cart('cg_a', 'tg_a'); perform t.cart('cg_b', 'tg_b');
  perform t.save('cg_a', 'tg_a', jsonb_build_array(t.line('pga', 5)));
  perform t.chk('G1 la reserva de A no afecta el disponible de B', t.avail('pgb', 'tg_b') = 5 and t.avail('pga', 'tg_a') = 0);
  -- el carrito de B apunta a un producto de A: se ignora (no reserva ni toca la reserva de A)
  perform t.save('cg_b', 'tg_b', jsonb_build_array(t.line('pga', 3)));
  perform t.chk('G2 producto de otro tenant en un carrito no genera reserva', t.resv('cg_b') = 0 and t.resv('cg_a') = 5);
  perform t.chk('G3 stock_available con tenant ajeno no ve ni stock ni reservas', public.stock_available(t.id('tg_b'), t.id('pga'), null) = 0);
  insert into public.profiles(id, tenant_id, role) values (uid_a, t.id('tg_a'), 'tenant_admin'), (uid_b, t.id('tg_b'), 'tenant_admin');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', uid_b)::text, true);
  set local role authenticated;
  select count(*) into n from public.stock_reservations;
  reset role;
  perform t.chk('G4 RLS: el tenant B no ve reservas del A', n = 0, 'n=' || n);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', uid_a)::text, true);
  set local role authenticated;
  select count(*) into n from public.stock_reservations;
  reset role;
  perform t.chk('G5 RLS: el tenant A ve la suya', n = 1, 'n=' || n);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ============ H. Privilegios y escritura de usuarios ============
do $$
declare r boolean;
begin
  perform t.tenant('th'); perform t.product('ph', 'th', 5); perform t.cart('ch', 'th');
  perform t.save('ch', 'th', jsonb_build_array(t.line('ph', 1)));
  perform t.chk('H1 authenticated no puede ejecutar stock_available', not has_function_privilege('authenticated', 'public.stock_available(uuid,uuid,uuid,uuid,uuid)', 'execute'));
  perform t.chk('H2 anon no puede ejecutar sync_cart_reservations', not has_function_privilege('anon', 'public.sync_cart_reservations(uuid,boolean)', 'execute'));
  perform t.chk('H3 authenticated no puede ejecutar stock_availability_rows', not has_function_privilege('authenticated', 'public.stock_availability_rows(uuid,uuid[],uuid)', 'execute'));
  perform t.chk('H4 service_role puede ejecutar las funciones de disponibilidad y reserva', has_function_privilege('service_role', 'public.stock_available(uuid,uuid,uuid,uuid,uuid)', 'execute') and has_function_privilege('service_role', 'public.sync_cart_reservations(uuid,boolean)', 'execute') and has_function_privilege('service_role', 'public.save_cart_lines(uuid,uuid,jsonb,jsonb)', 'execute'));
  perform t.chk('H5 authenticated no puede ejecutar save_cart_lines', not has_function_privilege('authenticated', 'public.save_cart_lines(uuid,uuid,jsonb,jsonb)', 'execute'));
  perform t.chk('H6 authenticated no puede ejecutar funciones de trigger/expiracion', not has_function_privilege('authenticated', 'public.expire_storefront_reservations()', 'execute') and not has_function_privilege('authenticated', 'public.consume_cart_reservation_on_confirm()', 'execute') and not has_function_privilege('authenticated', 'public.cart_items_sync_reservations()', 'execute'));
  perform t.chk('H7 authenticated sin INSERT/UPDATE/DELETE en la tabla', not has_table_privilege('authenticated', 'public.stock_reservations', 'insert') and not has_table_privilege('authenticated', 'public.stock_reservations', 'update') and not has_table_privilege('authenticated', 'public.stock_reservations', 'delete'));
  perform t.chk('H8 anon sin ningun privilegio en la tabla', not has_table_privilege('anon', 'public.stock_reservations', 'select'));
  perform t.chk('H9 cron programado cada minuto', (select schedule from cron.job where jobname = 'expire_storefront_reservations') = '* * * * *');
  perform t.chk('H10 funciones sin search_path abierto (todas con search_path vacio)',
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('stock_available','stock_availability_rows','sync_cart_reservations','cart_desired_reservations','cart_items_sync_reservations','carts_release_reservations','consume_cart_reservation_on_confirm','expire_storefront_reservations','cart_reserves_stock','save_cart_lines') and not coalesce(array_to_string(p.proconfig, ',') like '%search_path=""%', false)) = 0);
end $$;

-- ============ I. Regresion: venta sin carrito / sin reservas ============
do $$
declare oid uuid; mv int;
begin
  perform t.tenant('ti'); perform t.product('pi', 'ti', 4);
  insert into public.sales_orders(tenant_id, status, sales_channel) values (t.id('ti'), 'cotizacion', 'pos') returning id into oid;
  insert into public.sales_order_items(order_id, product_id, product_name, quantity) values (oid, t.id('pi'), 'pi', 3);
  update public.sales_orders set status = 'confirmada' where id = oid;
  perform t.chk('I1 venta sin carrito descuenta igual que antes (4 -> 1)', t.phys('pi') = 1);
  select count(*) into mv from public.stock_movements where reference_id = oid;
  perform t.chk('I2 un movimiento de salida', mv = 1);
  update public.sales_orders set status = 'cancelada' where id = oid;
  perform t.chk('I3 cancelar la devuelve (1 -> 4)', t.phys('pi') = 4);
  perform t.chk('I4 la venta sin carrito no crea reservas', (select count(*) from public.stock_reservations where tenant_id = t.id('ti')) = 0);
  -- una venta SIN carrito no consume la reserva de una cuenta abierta ajena
  perform t.cart('ci', 'ti'); perform t.save('ci', 'ti', jsonb_build_array(t.line('pi', 4)));
  insert into public.sales_orders(tenant_id, status, sales_channel) values (t.id('ti'), 'cotizacion', 'pos') returning id into oid;
  insert into public.sales_order_items(order_id, product_id, product_name, quantity) values (oid, t.id('pi'), 'pi', 1);
  update public.sales_orders set status = 'confirmada' where id = oid;
  perform t.chk('I5 venta sin carrito no toca la reserva de otra cuenta', t.resv('ci') = 4 and t.phys('pi') = 3);
  -- reconfirmar una cancelada no consume reservas
  update public.sales_orders set status = 'cancelada' where id = oid;
  update public.sales_orders set cart_id = t.id('ci') where id = oid;
  update public.sales_orders set status = 'confirmada' where id = oid;
  perform t.chk('I6 reconfirmar una cancelada (cancelada->confirmada) no consume la reserva', t.resv('ci') = 4);
  -- cantidades fraccionarias
  perform t.product('pf', 'ti', 2.5);
  perform t.cart('ci2', 'ti');
  perform t.save('ci2', 'ti', jsonb_build_array(t.line('pf', 2.25)));
  perform t.chk('I7 cantidades decimales (2.25 de 2.5 -> 0.25)', t.avail('pf', 'ti') = 0.25);
end $$;

-- ============ J. DTO por filas ============
do $$
declare r record; n int;
begin
  perform t.tenant('tj'); perform t.product('pj', 'tj', 10); perform t.cart('cj', 'tj');
  perform t.save('cj', 'tj', jsonb_build_array(t.line('pj', 4)));
  select * into r from public.stock_availability_rows(t.id('tj'), array[t.id('pj')]);
  perform t.chk('J1 stock_availability_rows: fisico 10, reservado 4, disponible 6', r.physical = 10 and r.reserved = 4 and r.available = 6, row_to_json(r)::text);
  select * into r from public.stock_availability_rows(t.id('tj'), array[t.id('pj')], t.id('cj'));
  perform t.chk('J2 excluyendo el propio carrito: disponible 10', r.available = 10);
  select count(*) into n from public.stock_availability_rows(t.id('tj'), array[gen_random_uuid()]);
  perform t.chk('J3 producto inexistente -> 0 filas', n = 0);
end $$;

-- ============ M. Rutas del navegador (JWT authenticated): cerrar/borrar con RLS ============
do $$
declare uid uuid := gen_random_uuid();
begin
  perform t.tenant('tm'); perform t.product('pm', 'tm', 5);
  perform t.cart('cm1', 'tm'); perform t.cart('cm2', 'tm');
  perform t.save('cm1', 'tm', jsonb_build_array(t.line('pm', 2)));
  perform t.save('cm2', 'tm', jsonb_build_array(t.line('pm', 1)));
  insert into public.profiles(id, tenant_id, role) values (uid, t.id('tm'), 'tenant_admin');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', uid)::text, true);
  set local role authenticated;
  update public.carts set status = 'converted' where id = t.id('cm1');   -- closeCart del frontend
  delete from public.carts where id = t.id('cm2');                       -- deleteCart del frontend
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform t.chk('M1 closeCart/deleteCart del navegador (rol authenticated) liberan las reservas', t.resv('cm1') = 0 and t.resv('cm2') = 0 and t.avail('pm', 'tm') = 5);
end $$;
