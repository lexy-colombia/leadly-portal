-- Pruebas de la migracion R2 (20261026130000_stock_availability_api.sql) sobre R1.
-- Prerrequisito: R1 + R2 aplicadas (ver run.sh seccion 4).
set client_min_messages = warning;

-- Esquema minimo adicional que usa el guard REAL y el DTO de variantes.
alter table public.sales_orders add column if not exists billing_address_id uuid;
alter table public.sales_orders add column if not exists shipping_address_id uuid;
alter table public.product_variants add column if not exists is_active boolean not null default true;
alter table public.product_variants add column if not exists deleted_at timestamptz;
create trigger trg_sales_orders_confirm_guard
  before update of status on public.sales_orders
  for each row
  when (old.status = 'cotizacion' and new.status = 'confirmada')
  execute function public.guard_sales_order_confirmation();

-- Helpers locales
create function t.order_for(p_k text, p_t text, p_channel text, p_cart text, p_p text, p_q numeric) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.sales_orders(tenant_id, sales_channel, cart_id, billing_address_id, shipping_address_id)
  values (t.id(p_t), p_channel, case when p_cart is null then null else t.id(p_cart) end, gen_random_uuid(), gen_random_uuid()) returning id into v;
  insert into public.sales_order_items(order_id, product_id, product_name, quantity) values (v, t.id(p_p), p_p, p_q);
  insert into t.ids values (p_k, v); return v;
end $$;
create function t.confirm(p_o text) returns text language plpgsql as $$
begin
  update public.sales_orders set status = 'confirmada' where id = t.id(p_o);
  return 'ok';
exception when others then return sqlerrm;
end $$;

-- ============ J. DTO de disponibilidad (RPC para el navegador) ============
do $$
declare uid_a uuid := gen_random_uuid(); uid_b uuid := gen_random_uuid(); n int; r record; v1 uuid; v2 uuid;
begin
  perform t.tenant('ja'); perform t.tenant('jb');
  perform t.product('pja', 'ja', 10); perform t.product('pjn', 'ja', 7, false); perform t.product('pje', 'ja', null);
  perform t.product('pjb', 'jb', 4);
  perform t.cart('cja1', 'ja'); perform t.cart('cja2', 'ja');
  perform t.save('cja1', 'ja', jsonb_build_array(t.line('pja', 3)));
  perform t.save('cja2', 'ja', jsonb_build_array(t.line('pja', 2)));
  -- producto con variantes
  insert into public.products(tenant_id, name, has_variants) values (t.id('ja'), 'pjv', true) returning id into v1;
  insert into t.ids values ('pjv', v1);
  insert into public.product_variants(tenant_id, product_id, name) values (t.id('ja'), v1, 'rojo') returning id into v2;
  perform t.setstock('pjv', t.id('ja_w1'), 6, v2);
  insert into public.product_variants(tenant_id, product_id, name) values (t.id('ja'), v1, 'azul-sin-stock');
  insert into public.profiles(id, tenant_id, role) values (uid_a, t.id('ja'), 'tenant_admin'), (uid_b, t.id('jb'), 'tenant_admin');

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', uid_a)::text, true);
  set local role authenticated;
  -- sin excluir: fisico 10 - reservado 5 = 5
  select * into r from public.get_stock_availability_totals(array[t.id('pja')]) where scope = 'product';
  perform t.chk('J1 total del producto = fisico - reservas de todos los carritos (5)', r.physical = 10 and r.reserved = 5 and r.available = 5, r::text);
  -- excluyendo la cuenta 1 (propia): 10 - 2 = 8
  select * into r from public.get_stock_availability_totals(array[t.id('pja')], t.id('cja1')) where scope = 'product';
  perform t.chk('J2 excluyendo la cuenta abierta propia: 10 - 2 = 8', r.available = 8 and r.reserved = 2, r::text);
  -- por bodega
  select * into r from public.get_stock_availability(array[t.id('pja')]);
  perform t.chk('J3 por bodega: misma cuenta', r.warehouse_id = t.id('ja_w1') and r.physical = 10 and r.reserved = 5 and r.available = 5, r::text);
  -- producto no rastreado: ausente
  select count(*) into n from public.get_stock_availability_totals(array[t.id('pjn')]);
  perform t.chk('J4 producto sin track_inventory no aparece (el frontend lo trata sin limite)', n = 0, 'n=' || n);
  -- producto rastreado sin filas de stock: fila product con 0
  select * into r from public.get_stock_availability_totals(array[t.id('pje')]) where scope = 'product';
  perform t.chk('J5 producto rastreado sin stock devuelve disponible 0 (no desaparece)', r.available = 0 and r.physical = 0, r::text);
  -- variantes
  select count(*) into n from public.get_stock_availability_totals(array[t.id('pjv')]) where scope = 'variant';
  perform t.chk('J6 una fila por variante activa (2), incluida la sin stock', n = 2, 'n=' || n);
  select * into r from public.get_stock_availability_totals(array[t.id('pjv')]) where scope = 'variant' and variant_id = v2;
  perform t.chk('J7 variante con stock: disponible 6', r.available = 6, r::text);
  select * into r from public.get_stock_availability_totals(array[t.id('pjv')]) where scope = 'product';
  perform t.chk('J8 total del producto con variantes = suma de variantes (6)', r.available = 6, r::text);
  -- aislamiento: A pide un producto de B
  select count(*) into n from public.get_stock_availability_totals(array[t.id('pjb')]);
  select n + count(*) into n from public.get_stock_availability(array[t.id('pjb')]);
  perform t.chk('J9 el tenant A no ve disponibilidad de productos de B', n = 0, 'n=' || n);
  -- null = todos los de MI tenant (solo rastreados)
  select count(*) into n from public.get_stock_availability_totals() where scope = 'product';
  perform t.chk('J10 sin ids: todos los productos rastreados del propio tenant (pja, pje, pjv = 3)', n = 3, 'n=' || n);
  -- orden estable (paginable con .range()): producto primero, luego variantes por id
  perform t.chk('J10b totales: orden determinista (product_id, variant_id nulls first)',
    (select array_agg(product_id::text || coalesce(variant_id::text, '') order by ord) from (select *, row_number() over () as ord from public.get_stock_availability_totals()) x)
    = (select array_agg(product_id::text || coalesce(variant_id::text, '') order by product_id, variant_id nulls first) from public.get_stock_availability_totals()));
  reset role;

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', uid_b)::text, true);
  set local role authenticated;
  select count(*) into n from public.get_stock_availability_totals(array[t.id('pja')]);
  select n + count(*) into n from public.get_stock_availability(array[t.id('pja')], t.id('cja1'));
  reset role;
  perform t.chk('J11 el tenant B tampoco ve el de A (ni usando un carrito ajeno para excluir)', n = 0, 'n=' || n);

  -- anon / sin sesion
  perform t.chk('J12 anon no puede ejecutar los RPC', not has_function_privilege('anon', 'public.get_stock_availability(uuid[],uuid)', 'execute') and not has_function_privilege('anon', 'public.get_stock_availability_totals(uuid[],uuid)', 'execute'));
  perform t.chk('J13 authenticated y service_role si', has_function_privilege('authenticated', 'public.get_stock_availability_totals(uuid[],uuid)', 'execute') and has_function_privilege('service_role', 'public.get_stock_availability(uuid[],uuid)', 'execute'));
  perform set_config('request.jwt.claims', '', true);
  set local role authenticated;
  select count(*) into n from public.get_stock_availability_totals(array[t.id('pja')]);
  reset role;
  perform t.chk('J14 sesion sin perfil/tenant: vacio', n = 0, 'n=' || n);
end $$;

-- ============ K. H3: el guard de confirmacion mira disponible ============
do $$
declare msg text; phys numeric;
begin
  perform t.tenant('tk2'); perform t.product('pk2', 'tk2', 5);
  perform t.cart('ck_pos', 'tk2'); perform t.cart('ck_own', 'tk2', 'storefront');
  -- una mesa POS reserva 4 de 5
  perform t.save('ck_pos', 'tk2', jsonb_build_array(t.line('pk2', 4)));
  -- venta de portal/IA (sin carrito) de 2: fisico 5 alcanza, disponible 1 NO
  perform t.order_for('ok_ia', 'tk2', 'whatsapp', null, 'pk2', 2);
  msg := t.confirm('ok_ia');
  perform t.chk('K1 venta directa (sin carrito) NO puede consumir lo reservado por una mesa', msg like 'INSUFFICIENT_STOCK%disponible 1, pedido 2%', msg);
  perform t.chk('K2 la venta rechazada sigue en cotizacion y no movio stock', (select status from public.sales_orders where id = t.id('ok_ia')) = 'cotizacion' and t.phys('pk2') = 5);
  -- pedir 1 si alcanza
  perform t.order_for('ok_ia1', 'tk2', 'whatsapp', null, 'pk2', 1);
  msg := t.confirm('ok_ia1');
  perform t.chk('K3 pedir lo realmente disponible (1) se confirma', msg = 'ok' and t.phys('pk2') = 4, msg);
  -- la mesa sigue con su reserva de 4 y fisico 4: ya no hay disponible, pero la mesa conserva lo suyo
  perform t.chk('K4 la reserva de la mesa sigue intacta (4)', t.resv('ck_pos') = 4);
  -- venta del PROPIO carrito: su reserva no cuenta contra si misma
  perform t.product('pk3', 'tk2', 3);
  perform t.save('ck_own', 'tk2', jsonb_build_array(t.line('pk3', 3)));
  perform t.order_for('ok_own', 'tk2', 'storefront', 'ck_own', 'pk3', 3);
  msg := t.confirm('ok_own');
  perform t.chk('K5 la venta de la propia cuenta reservada se confirma (excluye su reserva)', msg = 'ok', msg);
  perform t.chk('K6 consumio la reserva y descontó fisico una sola vez', t.resv('ck_own') = 0 and t.phys('pk3') = 0, 'resv=' || t.resv('ck_own') || ' phys=' || t.phys('pk3'));
  -- reserva vencida no bloquea
  perform t.product('pk4', 'tk2', 2); perform t.cart('ck_sf2', 'tk2', 'storefront');
  perform t.save('ck_sf2', 'tk2', jsonb_build_array(t.line('pk4', 2)));
  update public.stock_reservations set expires_at = now() - interval '1 minute' where cart_id = t.id('ck_sf2');
  perform t.order_for('ok_exp', 'tk2', 'whatsapp', null, 'pk4', 2);
  msg := t.confirm('ok_exp');
  perform t.chk('K7 una reserva vencida no bloquea la venta directa', msg = 'ok', msg);
  -- canal POS no se bloquea (decision de 2026-09-06 intacta)
  perform t.product('pk5', 'tk2', 1); perform t.cart('ck_pos2', 'tk2');
  perform t.save('ck_pos2', 'tk2', jsonb_build_array(t.line('pk5', 1)));
  perform t.order_for('ok_pos', 'tk2', 'pos', null, 'pk5', 1);
  msg := t.confirm('ok_pos');
  perform t.chk('K8 canal pos sigue saltandose el chequeo del guard', msg = 'ok', msg);
  -- producto no rastreado no se chequea
  perform t.product('pk6', 'tk2', 0, false);
  perform t.order_for('ok_nt', 'tk2', 'whatsapp', null, 'pk6', 9);
  msg := t.confirm('ok_nt');
  perform t.chk('K9 producto sin track_inventory no se chequea', msg = 'ok', msg);
  -- reserva de OTRO tenant no afecta
  perform t.tenant('tk3'); perform t.product('pk7', 'tk3', 3);
  perform t.order_for('ok_t3', 'tk3', 'whatsapp', null, 'pk7', 3);
  msg := t.confirm('ok_t3');
  perform t.chk('K10 reservas de otro tenant no cuentan', msg = 'ok', msg);
  perform t.chk('K11 guard sin EXECUTE para authenticated', not has_function_privilege('authenticated', 'public.guard_sales_order_confirmation()', 'execute'));
end $$;

-- ============ L. H2: cart_settle_billed_items ============
do $$
declare a uuid; b uuid; c uuid; qty numeric;
begin
  perform t.tenant('tl'); perform t.product('pl1', 'tl', 20); perform t.product('pl2', 'tl', 20); perform t.product('pl3', 'tl', 20);
  perform t.cart('cl', 'tl');
  perform t.save('cl', 'tl', jsonb_build_array(t.line('pl1', 5), t.line('pl2', 4), t.line('pl3', 1)));
  select id into a from public.cart_items where cart_id = t.id('cl') and product_name = 'pl1';
  select id into b from public.cart_items where cart_id = t.id('cl') and product_name = 'pl2';
  select id into c from public.cart_items where cart_id = t.id('cl') and product_name = 'pl3';
  -- cobro completo de pl3, parcial de pl1 (2 de 5), pl2 intacta
  perform public.cart_settle_billed_items(t.id('cl'), t.id('tl'), array[c], jsonb_build_array(jsonb_build_object('id', a, 'qty', 2)));
  perform t.chk('L1 linea cobrada completa se elimina', not exists (select 1 from public.cart_items where id = c));
  select quantity into qty from public.cart_items where id = a;
  perform t.chk('L2 cobro parcial descuenta (5 - 2 = 3)', qty = 3, 'qty=' || qty);
  perform t.chk('L3 reservas sincronizadas: pl1=3, pl2=4, pl3=0', t.resv('cl') = 7 and (select coalesce(sum(quantity),0) from public.stock_reservations where cart_id = t.id('cl') and product_id = t.id('pl3')) = 0);
  -- cantidad que se pasa de la linea: se elimina, no queda negativa
  perform public.cart_settle_billed_items(t.id('cl'), t.id('tl'), array[]::uuid[], jsonb_build_array(jsonb_build_object('id', b, 'qty', 9)));
  perform t.chk('L4 descuento que deja <= 0 elimina la linea (nunca negativa)', not exists (select 1 from public.cart_items where id = b));
  -- tenant ajeno
  perform t.tenant('tl2');
  perform t.expect_error('L5 con otro tenant: Carrito no encontrado (LX404), sin tocar nada', format('select public.cart_settle_billed_items(%L, %L, array[%L]::uuid[], %L::jsonb)', t.id('cl'), t.id('tl2'), a, '[]'), '%Carrito no encontrado%', 'LX404');
  perform t.chk('L6 la linea del carrito ajeno sigue ahi', exists (select 1 from public.cart_items where id = a));
  perform t.chk('L7 sin EXECUTE para authenticated/anon', not has_function_privilege('authenticated', 'public.cart_settle_billed_items(uuid,uuid,uuid[],jsonb)', 'execute') and not has_function_privilege('anon', 'public.cart_settle_billed_items(uuid,uuid,uuid[],jsonb)', 'execute') and has_function_privilege('service_role', 'public.cart_settle_billed_items(uuid,uuid,uuid[],jsonb)', 'execute'));
end $$;
