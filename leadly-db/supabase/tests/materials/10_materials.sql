set client_min_messages = warning;
create trigger trg_sales_orders_confirm_guard
  before update of status on public.sales_orders
  for each row when (old.status = 'cotizacion' and new.status = 'confirmada')
  execute function public.guard_sales_order_confirmation();

-- helpers
create function t.material(p_k text, p_t text, p_qty numeric, p_unit text default 'kg', p_cost numeric default 10) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.materials(tenant_id, name, unit, cost) values (t.id(p_t), p_k, p_unit, p_cost) returning id into v;
  insert into t.ids values (p_k, v);
  if p_qty > 0 then
    insert into public.material_movements(tenant_id, material_id, warehouse_id, movement_type, quantity, reference_type)
    values (t.id(p_t), v, t.id(p_t || '_w1'), 'carga_inicial', p_qty, 'carga_inicial');
  end if;
  return v;
end $$;
create function t.recipe(p_k text, p_t text) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.products(tenant_id, name, inventory_mode, track_inventory) values (t.id(p_t), p_k, 'recipe', false) returning id into v;
  insert into t.ids values (p_k, v); return v;
end $$;
create function t.bom(p_p text, p_m text, p_q numeric) returns void language sql as $$
  insert into public.product_bom(tenant_id, product_id, material_id, quantity)
  select tenant_id, id, (select id from public.materials where id = t.id(p_m)), p_q from public.products where id = t.id(p_p) $$;
create function t.mq(p_m text) returns numeric language sql as $$ select coalesce(sum(quantity), 0) from public.material_stock where material_id = t.id(p_m) $$;
create function t.mres(p_c text) returns numeric language sql as $$ select coalesce(sum(quantity), 0) from public.material_reservations where cart_id = t.id(p_c) $$;
create function t.mavail(p_m text, p_t text, p_excl uuid default null) returns numeric language sql as $$ select public.material_available(t.id(p_t), t.id(p_m), p_excl) $$;
create function t.ravail(p_p text, p_t text) returns numeric language sql as $$
  select available from public.stock_availability_rows(t.id(p_t), array[t.id(p_p)]) where product_id = t.id(p_p) $$;
create function t.order_for(p_k text, p_t text, p_channel text, p_cart text) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.sales_orders(tenant_id, sales_channel, cart_id, billing_address_id, shipping_address_id)
  values (t.id(p_t), p_channel, case when p_cart is null then null else t.id(p_cart) end, gen_random_uuid(), gen_random_uuid()) returning id into v;
  insert into t.ids values (p_k, v); return v;
end $$;
create function t.item(p_o text, p_p text, p_q numeric) returns void language sql as $$
  insert into public.sales_order_items(order_id, product_id, product_name, quantity) values (t.id(p_o), t.id(p_p), p_p, p_q) $$;
create function t.confirm(p_o text) returns text language plpgsql as $$
begin update public.sales_orders set status = 'confirmada' where id = t.id(p_o); return 'ok';
exception when others then return sqlerrm; end $$;
create function t.cancel(p_o text) returns void language sql as $$ update public.sales_orders set status = 'cancelada' where id = t.id(p_o) $$;

-- ============ A. Venta con insumo compartido en 2 lineas ============
do $$
declare s text; n int;
begin
  perform t.tenant('ta'); perform t.material('carne_a', 'ta', 10); perform t.material('sal_a', 'ta', 5, 'g', 1);
  perform t.recipe('churrasco_a', 'ta'); perform t.recipe('pechuga_a', 'ta');
  perform t.bom('churrasco_a', 'carne_a', 0.25); perform t.bom('churrasco_a', 'sal_a', 0.5);
  perform t.bom('pechuga_a', 'carne_a', 0.2);
  perform t.product('coca_a', 'ta', 20);
  perform t.chk('A0 recipe queda con track_inventory=true (trigger)', (select track_inventory from public.products where id = t.id('churrasco_a')));
  perform t.chk('A1 disponible derivado churrasco = min(10/0.25, 5/0.5) = 10', t.ravail('churrasco_a', 'ta') = 10, t.ravail('churrasco_a', 'ta')::text);
  perform t.chk('A2 disponible derivado pechuga = 50', t.ravail('pechuga_a', 'ta') = 50);
  perform t.order_for('oa', 'ta', 'portal', null);
  perform t.item('oa', 'churrasco_a', 2); perform t.item('oa', 'pechuga_a', 3); perform t.item('oa', 'coca_a', 1);
  s := t.confirm('oa');
  perform t.chk('A3 confirmar (guard portal, insumos suficientes) ok', s = 'ok', s);
  perform t.chk('A4 carne: 10 - (2*0.25 + 3*0.2 = 1.1) = 8.9', t.mq('carne_a') = 8.9, t.mq('carne_a')::text);
  perform t.chk('A5 sal: 5 - 1 = 4', t.mq('sal_a') = 4);
  select count(*) into n from public.material_movements where reference_id = t.id('oa') and material_id = t.id('carne_a') and movement_type = 'salida' and reference_type = 'venta';
  perform t.chk('A6 insumo compartido = UN movimiento sumado (1.1)', n = 1 and (select quantity from public.material_movements where reference_id = t.id('oa') and material_id = t.id('carne_a')) = 1.1);
  perform t.chk('A7 unit_cost del movimiento = costo vigente', (select unit_cost from public.material_movements where reference_id = t.id('oa') and material_id = t.id('carne_a')) = 10);
  perform t.chk('A8 productos recipe NO generan stock_movements (sin doble descuento)', not exists (select 1 from public.stock_movements where reference_id = t.id('oa') and product_id in (t.id('churrasco_a'), t.id('pechuga_a'))));
  perform t.chk('A9 producto stock sigue descontando 1 (regresion)', t.phys('coca_a') = 19 and exists (select 1 from public.stock_movements where reference_id = t.id('oa') and product_id = t.id('coca_a') and movement_type = 'salida'));
  perform t.chk('A10 coca no genera movimientos de insumos', not exists (select 1 from public.material_movements where reference_id = t.id('oa') and material_id not in (t.id('carne_a'), t.id('sal_a'))));
  -- B. cancelar revierte; reconfirmar y cancelar de nuevo (neta)
  perform t.cancel('oa');
  perform t.chk('B1 cancelar revierte insumos (10 y 5)', t.mq('carne_a') = 10 and t.mq('sal_a') = 5, t.mq('carne_a')::text);
  perform t.chk('B2 cancelar devuelve el producto stock', t.phys('coca_a') = 20);
  s := t.confirm('oa');
  perform t.chk('B3 reconfirmar descuenta otra vez', s = 'ok' and t.mq('carne_a') = 8.9, s);
  perform t.cancel('oa');
  perform t.chk('B4 segunda cancelacion: reversion NETA (vuelve a 10, no 11.1)', t.mq('carne_a') = 10, t.mq('carne_a')::text);
end $$;

-- ============ C. Carga: insumo insuficiente -> LX422 (POS y tienda) ============
do $$
declare v_msg text; v_state text; v_detail text;
begin
  perform t.tenant('tc'); perform t.material('carne_c', 'tc', 1); perform t.recipe('ch_c', 'tc'); perform t.recipe('pe_c', 'tc');
  perform t.bom('ch_c', 'carne_c', 0.25); perform t.bom('pe_c', 'carne_c', 0.2);
  perform t.cart('cc1', 'tc'); perform t.cart('cc2', 'tc'); perform t.cart('cc3', 'tc', 'storefront');
  perform t.save('cc1', 'tc', jsonb_build_array(t.line('ch_c', 2)));
  perform t.chk('C1 reserva 0.5 de carne', t.mres('cc1') = 0.5);
  perform t.chk('C2 otro carrito ve disponible 0.5', t.mavail('carne_c', 'tc', t.id('cc2')) = 0.5);
  perform t.chk('C3 el propio carrito ve 1 (excluye su reserva)', t.mavail('carne_c', 'tc', t.id('cc1')) = 1);
  perform t.chk('C4 disponible derivado de pechuga para el publico = floor(0.5/0.2)=2', t.ravail('pe_c', 'tc') = 2, t.ravail('pe_c', 'tc')::text);
  begin
    perform t.save('cc2', 'tc', jsonb_build_array(t.line('pe_c', 3)));
    perform t.chk('C5 pedir 3 pechugas (0.6 > 0.5) rechaza', false, 'no fallo');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_detail = pg_exception_detail; v_msg := sqlerrm;
    perform t.chk('C5 LX422', v_state = 'LX422', v_state);
    perform t.chk('C6 mensaje nombra producto e insumo', v_msg like '%"pe_c"%"carne_c"%', v_msg);
    perform t.chk('C7 DETAIL: product_id, material_name, available en unidades', (v_detail::jsonb -> 0 ->> 'product_id') = t.id('pe_c')::text and (v_detail::jsonb -> 0 ->> 'material_name') = 'carne_c' and (v_detail::jsonb -> 0 ->> 'available')::numeric = 2 and (v_detail::jsonb -> 0 ->> 'requested')::numeric = 3, v_detail);
  end;
  perform t.chk('C8 el carrito rechazado no cargo lineas', (select count(*) from public.cart_items where cart_id = t.id('cc2')) = 0);
  -- insumo compartido: cada linea cabe sola, la suma no
  perform t.material('carne_c2', 'tc', 1); perform t.recipe('x1', 'tc'); perform t.recipe('x2', 'tc');
  perform t.bom('x1', 'carne_c2', 0.6); perform t.bom('x2', 'carne_c2', 0.6);
  perform t.expect_error('C9 dos lineas con insumo compartido: la SUMA (1.2 > 1) rechaza', format('select t.save(%L, %L, jsonb_build_array(t.line(%L,1), t.line(%L,1)))', 'cc2', 'tc', 'x1', 'x2'), '%Sin stock suficiente%', 'LX422');
  perform t.save('cc2', 'tc', jsonb_build_array(t.line('x1', 1)));
  perform t.chk('C10 una sola linea (0.6) si carga', t.mres('cc2') = 0.6);
  -- sin ficha
  perform t.recipe('sinficha', 'tc');
  perform t.expect_error('C11 recipe sin ficha tecnica no se puede cargar', format('select t.save(%L, %L, jsonb_build_array(t.line(%L,1)))', 'cc3', 'tc', 'sinficha'), '%sin ficha t%', 'LX422');
  perform t.chk('C12 recipe sin ficha: disponible 0', t.ravail('sinficha', 'tc') = 0);
  -- insumo inactivo
  update public.materials set is_active = false where id = t.id('carne_c2');
  perform t.chk('C13 insumo inactivo: disponible 0 y producto derivado 0', t.mavail('carne_c2', 'tc') = 0 and t.ravail('x2', 'tc') = 0);
  update public.materials set is_active = true where id = t.id('carne_c2');
end $$;

-- ============ D. Reservas: liberar al cerrar / borrar / expirar tienda / consumir ============
do $$
declare o uuid; n int;
begin
  perform t.tenant('td'); perform t.material('m_d', 'td', 10); perform t.recipe('r_d', 'td'); perform t.bom('r_d', 'm_d', 2);
  perform t.cart('cd1', 'td'); perform t.cart('cd2', 'td'); perform t.cart('cd3', 'td', 'storefront'); perform t.cart('cd4', 'td', 'portal');
  perform t.save('cd1', 'td', jsonb_build_array(t.line('r_d', 1)));
  perform t.save('cd2', 'td', jsonb_build_array(t.line('r_d', 1)));
  perform t.chk('D1 dos cuentas reservan 4 de 10', t.mres('cd1') + t.mres('cd2') = 4);
  update public.carts set status = 'converted' where id = t.id('cd1');
  perform t.chk('D2 cerrar el carrito libera insumos', t.mres('cd1') = 0);
  delete from public.carts where id = t.id('cd2');
  perform t.chk('D3 borrar el carrito libera insumos (cascada)', t.mres('cd2') = 0);
  perform t.save('cd4', 'td', jsonb_build_array(t.line('r_d', 1)));
  perform t.chk('D4 carrito portal NO reserva insumos', t.mres('cd4') = 0);
  perform t.save('cd3', 'td', jsonb_build_array(t.line('r_d', 2)));
  perform t.chk('D5 tienda reserva con vencimiento (4)', t.mres('cd3') = 4 and (select expires_at is not null from public.material_reservations where cart_id = t.id('cd3')));
  update public.material_reservations set expires_at = now() - interval '1 minute' where cart_id = t.id('cd3');
  perform t.chk('D6 reserva vencida ya no cuenta (disponible 10) sin esperar al cron', t.mavail('m_d', 'td') = 10);
  perform public.expire_storefront_reservations();
  perform t.chk('D7 el job borra la reserva vencida y marca abandono', t.mres('cd3') = 0 and (select abandoned_at is not null from public.carts where id = t.id('cd3')));
  -- consumo al confirmar: cuenta POS con 3 unidades, se cobran 2
  perform t.cart('cd5', 'td'); perform t.save('cd5', 'td', jsonb_build_array(t.line('r_d', 3)));
  perform t.chk('D8 cuenta de 3 reserva 6', t.mres('cd5') = 6);
  perform t.order_for('od', 'td', 'pos', 'cd5'); perform t.item('od', 'r_d', 2);
  perform t.chk('D9 confirmar (pos)', t.confirm('od') = 'ok');
  perform t.chk('D10 la reserva se consume por lo cobrado (6 - 4 = 2) y el fisico baja 4', t.mres('cd5') = 2 and t.mq('m_d') = 6, t.mres('cd5')::text || '/' || t.mq('m_d')::text);
end $$;

-- ============ E. Guard de confirmacion (no-POS bloquea; POS no) y greatest(0) ============
do $$
declare s text; kard numeric;
begin
  perform t.tenant('te'); perform t.material('m_e', 'te', 1); perform t.recipe('r_e', 'te'); perform t.bom('r_e', 'm_e', 0.4);
  perform t.order_for('oe1', 'te', 'portal', null); perform t.item('oe1', 'r_e', 3);
  s := t.confirm('oe1');
  perform t.chk('E1 portal: insumos insuficientes -> INSUFFICIENT_STOCK con insumo', s like 'INSUFFICIENT_STOCK%' and s like '%m_e%', s);
  perform t.chk('E2 el bloqueo no descontó nada', t.mq('m_e') = 1);
  -- reserva ajena bloquea
  perform t.cart('ce1', 'te'); perform t.save('ce1', 'te', jsonb_build_array(t.line('r_e', 2)));
  perform t.order_for('oe2', 'te', 'portal', null); perform t.item('oe2', 'r_e', 1);
  s := t.confirm('oe2');
  perform t.chk('E3 el guard descuenta reservas de OTROS carritos (0.2 libre < 0.4)', s like 'INSUFFICIENT_STOCK%', s);
  -- POS: el trigger no bloquea y el stock se recorta a 0 (kardex completo)
  perform t.order_for('oe3', 'te', 'pos', null); perform t.item('oe3', 'r_e', 5);
  s := t.confirm('oe3');
  perform t.chk('E4 pos: no bloquea en DB', s = 'ok', s);
  select coalesce(sum(quantity), 0) into kard from public.material_movements where reference_id = t.id('oe3') and movement_type = 'salida';
  perform t.chk('E5 greatest(0): kardex registra la salida completa (2) y material_stock queda en 0', kard = 2 and t.mq('m_e') = 0, kard::text || '/' || t.mq('m_e')::text);
  perform t.chk('E6 disponible nunca negativo', t.mavail('m_e', 'te') = 0);
  -- sin ficha: portal bloquea
  perform t.recipe('sf_e', 'te'); perform t.order_for('oe4', 'te', 'portal', null); perform t.item('oe4', 'sf_e', 1);
  s := t.confirm('oe4');
  perform t.chk('E7 portal: recipe sin ficha no se confirma', s like 'INSUFFICIENT_STOCK%ficha%', s);
end $$;

-- ============ F. Aislamiento entre tenants ============
do $$
declare v_state text;
begin
  perform t.tenant('tf1'); perform t.tenant('tf2');
  perform t.material('m_f1', 'tf1', 10); perform t.material('m_f2', 'tf2', 10);
  perform t.recipe('r_f1', 'tf1');
  begin
    insert into public.product_bom(tenant_id, product_id, material_id, quantity) values (t.id('tf1'), t.id('r_f1'), t.id('m_f2'), 1);
    perform t.chk('F1 BOM con insumo de otro tenant rechazado', false, 'no fallo');
  exception when others then get stacked diagnostics v_state = returned_sqlstate; perform t.chk('F1 BOM con insumo de otro tenant rechazado', v_state = 'LX403', v_state); end;
  begin
    insert into public.material_movements(tenant_id, material_id, warehouse_id, movement_type, quantity, reference_type) values (t.id('tf1'), t.id('m_f2'), t.id('tf1_w1'), 'entrada', 1, 'compra');
    perform t.chk('F2 movimiento con insumo ajeno rechazado', false, 'no fallo');
  exception when others then get stacked diagnostics v_state = returned_sqlstate; perform t.chk('F2 movimiento con insumo ajeno rechazado', v_state = 'LX403', v_state); end;
  begin
    insert into public.material_movements(tenant_id, material_id, warehouse_id, movement_type, quantity, reference_type) values (t.id('tf1'), t.id('m_f1'), t.id('tf2_w1'), 'entrada', 1, 'compra');
    perform t.chk('F3 movimiento con bodega ajena rechazado', false, 'no fallo');
  exception when others then get stacked diagnostics v_state = returned_sqlstate; perform t.chk('F3 movimiento con bodega ajena rechazado', v_state = 'LX403', v_state); end;
  perform t.chk('F4 disponible de un insumo consultado con el tenant equivocado = 0', t.mavail('m_f2', 'tf1') = 0);
  perform t.bom('r_f1', 'm_f1', 1);
  perform t.order_for('of1', 'tf1', 'portal', null); perform t.item('of1', 'r_f1', 4);
  perform t.chk('F5 confirmar en tf1', t.confirm('of1') = 'ok');
  perform t.chk('F6 tf2 intacto', t.mq('m_f2') = 10);
  perform t.chk('F7 nombre de insumo unico por tenant (mismo nombre en otro tenant permitido, duplicado en el mismo no)', true);
  begin insert into public.materials(tenant_id, name, unit) values (t.id('tf1'), 'M_F1', 'kg'); perform t.chk('F7b duplicado (case-insens.) rechazado', false, 'no fallo');
  exception when unique_violation then perform t.chk('F7b duplicado (case-insens.) rechazado', true); end;
  -- RLS: un usuario de tf2 no ve ni inserta en tf1; no puede forjar movimientos de venta
  insert into public.profiles(id, tenant_id, role) values ('00000000-0000-0000-0000-0000000000f2', t.id('tf2'), 'tenant_admin');
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f2', true);
  set local role authenticated;
  perform t.chk('F8 RLS: el usuario de tf2 no ve insumos de tf1', (select count(*) from public.materials where tenant_id = t.id('tf1')) = 0);
  begin
    insert into public.material_movements(tenant_id, material_id, warehouse_id, movement_type, quantity, reference_type, reference_id) values (t.id('tf2'), t.id('m_f2'), t.id('tf2_w1'), 'salida', 1, 'venta', gen_random_uuid());
    perform t.chk('F9 RLS: usuario no puede insertar reference_type venta', false, 'no fallo');
  exception when others then perform t.chk('F9 RLS: usuario no puede insertar reference_type venta', sqlstate = '42501', sqlstate); end;
  begin
    insert into public.material_movements(tenant_id, material_id, warehouse_id, movement_type, quantity, reference_type) values (t.id('tf2'), t.id('m_f2'), t.id('tf2_w1'), 'ajuste_positivo', 5, 'ajuste_manual');
    perform t.chk('F10 usuario SI puede registrar un ajuste manual', true);
  exception when others then perform t.chk('F10 usuario SI puede registrar un ajuste manual', false, sqlerrm); end;
  perform t.chk('F11 el ajuste actualizo material_stock via trigger (15)', (select quantity from public.material_stock where material_id = t.id('m_f2')) = 15);
  begin update public.material_stock set quantity = 999 where material_id = t.id('m_f2'); perform t.chk('F12 usuario no escribe material_stock', (select quantity from public.material_stock where material_id = t.id('m_f2')) = 15);
  exception when others then perform t.chk('F12 usuario no escribe material_stock', true); end;
  reset role;
end $$;

-- ============ G. RPC get_materials_overview / get_product_bom_cost (tenant de la sesion) ============
do $$
declare r record; n int;
begin
  perform t.tenant('tg'); perform t.tenant('tg2');
  perform t.material('arroz', 'tg', 10, 'kg', 4); perform t.material('azucar', 'tg', 0, 'kg', 3); perform t.material('aceite', 'tg', 2, 'l', 8);
  perform t.material('otro_tenant', 'tg2', 99);
  perform t.recipe('r_g', 'tg'); perform t.bom('r_g', 'arroz', 0.5); perform t.bom('r_g', 'aceite', 0.1);
  perform t.cart('cg', 'tg'); perform t.save('cg', 'tg', jsonb_build_array(t.line('r_g', 4)));
  insert into public.profiles(id, tenant_id, role) values ('00000000-0000-0000-0000-0000000000a1', t.id('tg'), 'tenant_admin');
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', true);
  select count(*) into n from public.get_materials_overview();
  perform t.chk('G1 lista solo los insumos del tenant de la sesion (3)', n = 3, n::text);
  perform t.chk('G2 columna count = total en cada fila y orden por nombre', (select bool_and("count" = 3) from public.get_materials_overview()) and (select string_agg(name, ',' order by name) from public.get_materials_overview()) = 'aceite,arroz,azucar');
  select * into r from public.get_materials_overview('arro');
  perform t.chk('G3 busqueda por nombre; total_quantity/reserved/available', r.name = 'arroz' and r.total_quantity = 10 and r.reserved = 2 and r.available = 8, row_to_json(r)::text);
  perform t.chk('G4 paginacion: limit 2 offset 2 -> 1 fila, count 3', (select count(*) from public.get_materials_overview(null, 2, 2)) = 1 and (select "count" from public.get_materials_overview(null, 2, 2)) = 3);
  update public.materials set is_active = false where id = t.id('azucar');
  perform t.chk('G5 incluye inactivos', (select count(*) from public.get_materials_overview()) = 3 and (select is_active from public.get_materials_overview('azuc')) = false);
  perform t.chk('G6 costo de la ficha = 0.5*4 + 0.1*8 = 2.8', public.get_product_bom_cost(t.id('r_g')) = 2.8, public.get_product_bom_cost(t.id('r_g'))::text);
  perform set_config('request.jwt.claim.sub', '', true);
  perform t.chk('G7 sin sesion: 0 filas', (select count(*) from public.get_materials_overview()) = 0);
end $$;

-- ============ H. Reglas de producto ============
do $$
declare v_state text;
begin
  perform t.tenant('th');
  begin
    insert into public.products(tenant_id, name, inventory_mode, has_variants) values (t.id('th'), 'rv', 'recipe', true);
    perform t.chk('H1 recipe con variantes rechazado', false, 'no fallo');
  exception when others then get stacked diagnostics v_state = returned_sqlstate; perform t.chk('H1 recipe con variantes rechazado', v_state = 'LX422', v_state); end;
  perform t.product('ph', 'th', 5);
  begin update public.products set inventory_mode = 'recipe', has_variants = true where id = t.id('ph'); perform t.chk('H2 pasar a recipe+variantes rechazado', false, 'no fallo');
  exception when others then perform t.chk('H2 pasar a recipe+variantes rechazado', true); end;
  perform t.cart('ch', 'th'); perform t.save('ch', 'th', jsonb_build_array(t.line('ph', 2)));
  update public.products set inventory_mode = 'recipe' where id = t.id('ph');
  perform t.chk('H3 pasar a recipe libera sus reservas de stock propio', t.resv('ch') = 0);
  perform t.chk('H4 el stock fisico viejo no cuenta en el disponible de un recipe (sin ficha = 0)', t.ravail('ph', 'th') = 0);
  begin insert into public.materials(tenant_id, name, unit) values (t.id('th'), 'x', 'lb'); perform t.chk('H5 unidad invalida rechazada', false, 'no fallo');
  exception when check_violation then perform t.chk('H5 unidad invalida rechazada', true); end;
  perform t.chk('H6 modulo materials en el catalogo y 6 permisos', 'materials' = any (public.entitlement_module_keys()) and (select count(*) from public.permission_actions where key like 'materials.%' or key = 'products.manage_bom') = 6);
  begin insert into public.tenant_enabled_modules(tenant_id, module_key) values (t.id('th'), 'materials'); perform t.chk('H7 CHECK de tenant_enabled_modules acepta materials', true);
  exception when others then perform t.chk('H7 CHECK de tenant_enabled_modules acepta materials', false, sqlerrm); end;
  begin insert into public.billing_plan_modules(plan_id, module_key) values (gen_random_uuid(), 'materials'); perform t.chk('H8 CHECK de billing_plan_modules acepta materials', true);
  exception when others then perform t.chk('H8 CHECK de billing_plan_modules acepta materials', false, sqlerrm); end;
end $$;
