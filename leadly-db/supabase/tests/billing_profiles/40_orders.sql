set client_min_messages = warning;
create function t.mkcart(p_k text, p_origin text, p_contact text default null) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.carts(tenant_id, origin, contact_id) values (t.id('A'), p_origin, case when p_contact is null then null else t.id(p_contact) end) returning id into v;
  insert into t.ids values (p_k, v); return v;
end $$;

do $$
declare r text; v uuid; v2 uuid; bp_full uuid; bp_other uuid; res jsonb; n int; o uuid; s record;
begin
  select id into bp_full from public.client_billing_profiles where client_id = t.id('c_full');
  select id into bp_other from public.client_billing_profiles where client_id = t.id('c_other');

  -- O1 backfill de fulfillment_method
  perform t.ok('O1 pedido POS preexistente -> on_site', (select fulfillment_method from public.sales_orders where id = t.id('o_pos')) = 'on_site');
  perform t.ok('O1b pedidos no POS (portal, whatsapp, canal nulo) -> delivery',
    (select count(*) from public.sales_orders where tenant_id = t.id('A') and coalesce(sales_channel, '') <> 'pos' and fulfillment_method <> 'delivery') = 0
    and (select fulfillment_method from public.sales_orders where id = t.id('o_null')) = 'delivery');
  perform t.ok('O1c tambien el POS del tenant B', (select fulfillment_method from public.sales_orders where tenant_id = t.id('B') and sales_channel = 'pos') = 'on_site');
  perform t.ok('O1d el backfill NO movio updated_at del pedido POS',
    (select updated_at from public.sales_orders where id = t.id('o_pos')) = '2026-01-02'::timestamptz);
  perform t.ok('O1e el trigger de updated_at quedo habilitado de nuevo',
    (select tgenabled from pg_trigger where tgname = 'sales_orders_set_updated_at') = 'O'
    and (select tgenabled from pg_trigger where tgname = 'carts_set_updated_at') = 'O');

  -- O2 POS siempre on_site; default delivery para el resto
  insert into public.sales_orders(tenant_id, contact_id, sales_channel) values (t.id('A'), t.id('c_ship'), 'pos') returning id into v;
  perform t.ok('O2 insert POS sin el campo -> on_site', (select fulfillment_method from public.sales_orders where id = v) = 'on_site');
  insert into public.sales_orders(tenant_id, contact_id, sales_channel, fulfillment_method) values (t.id('A'), t.id('c_ship'), 'pos', 'delivery') returning id into v;
  perform t.ok('O2b insert POS pidiendo delivery -> se fuerza on_site', (select fulfillment_method from public.sales_orders where id = v) = 'on_site');
  insert into public.sales_orders(tenant_id, contact_id, sales_channel) values (t.id('A'), t.id('c_ship'), 'storefront') returning id into v;
  perform t.ok('O2c insert de tienda sin el campo -> delivery (default seguro)', (select fulfillment_method from public.sales_orders where id = v) = 'delivery');
  r := t.try(format($q$insert into public.sales_orders(tenant_id, contact_id, sales_channel, fulfillment_method) values (%L, %L, 'portal', 'bogus')$q$, t.id('A'), t.id('c_ship')));
  perform t.ok('O2d valor invalido de fulfillment_method: rechazado', r like '23514%', r);
  insert into public.sales_orders(tenant_id, contact_id, sales_channel) values (t.id('A'), t.id('c_ship'), 'portal') returning id into v;
  update public.sales_orders set sales_channel = 'pos' where id = v;
  perform t.ok('O2e pasar un pedido a canal POS lo fuerza a on_site', (select fulfillment_method from public.sales_orders where id = v) = 'on_site');
  perform t.mkcart('cart_pos', 'pos'); perform t.mkcart('cart_sf', 'storefront');
  perform t.ok('O2f carrito POS -> on_site; tienda -> delivery',
    (select fulfillment_method from public.carts where id = t.id('cart_pos')) = 'on_site'
    and (select fulfillment_method from public.carts where id = t.id('cart_sf')) = 'delivery');

  -- O3 billing_profile_id: FK compuesta (tenant, cliente, perfil)
  insert into public.sales_orders(tenant_id, contact_id, sales_channel, billing_profile_id) values (t.id('A'), t.id('c_full'), 'portal', bp_full) returning id into v;
  perform t.ok('O3 pedido con SU perfil: permitido', v is not null);
  r := t.try(format($q$insert into public.sales_orders(tenant_id, contact_id, sales_channel, billing_profile_id) values (%L, %L, 'portal', %L)$q$, t.id('A'), t.id('c_full'), bp_other));
  perform t.ok('O3b pedido con perfil de OTRO cliente: rechazado', r like '23503%', r);
  r := t.try(format($q$insert into public.sales_orders(tenant_id, contact_id, sales_channel, billing_profile_id) values (%L, %L, 'portal', %L)$q$, t.id('B'), t.id('b_c1'), bp_full));
  perform t.ok('O3c pedido de B con perfil de A: rechazado', r like '23503%', r);
  r := t.try(format($q$update public.sales_orders set contact_id = %L where id = %L$q$, t.id('c_other'), v));
  perform t.ok('O3d cambiar solo el cliente: el perfil que ya no le pertenece se pone en NULL (no falla)',
    r = 'ok' and (select billing_profile_id from public.sales_orders where id = v) is null, r);
  r := t.try(format($q$update public.sales_orders set contact_id = %L, billing_profile_id = %L where id = %L$q$, t.id('c_ship'), bp_full, v));
  perform t.ok('O3d2 cambiar cliente Y fijar un perfil ajeno en la misma sentencia: ERROR 23503', r like '23503%', r);
  update public.sales_orders set contact_id = t.id('c_full'), billing_profile_id = bp_full where id = v;
  r := t.try(format($q$update public.sales_orders set contact_id = %L, billing_profile_id = null where id = %L$q$, t.id('c_other'), v));
  perform t.ok('O3e cambiar el cliente limpiando el perfil: permitido', r = 'ok', r);
  perform t.mkcart('cart_bp', 'portal', 'c_full');
  r := t.try(format($q$update public.carts set billing_profile_id = %L where id = %L$q$, bp_full, t.id('cart_bp')));
  perform t.ok('O3f carrito con perfil del cliente del carrito: permitido', r = 'ok', r);
  r := t.try(format($q$update public.carts set billing_profile_id = %L where id = %L$q$, bp_other, t.id('cart_bp')));
  perform t.ok('O3g carrito con perfil de otro cliente: rechazado', r like '23503%', r);
  perform t.mkcart('cart_nocontact', 'portal');
  r := t.try(format($q$update public.carts set billing_profile_id = %L where id = %L$q$, bp_full, t.id('cart_nocontact')));
  perform t.ok('O3h carrito sin cliente no puede llevar perfil (CHECK)', r like '23514%', r);
  r := t.try(format($q$delete from public.client_billing_profiles where id = %L$q$, bp_full));
  perform t.ok('O3i un perfil usado por un pedido no se borra fisicamente', r like '23503%', r);

  -- O4 shipping_address_id: FK compuesta al cliente dueño
  r := t.try(format($q$insert into public.sales_orders(tenant_id, contact_id, sales_channel, shipping_address_id) values (%L, %L, 'portal', %L)$q$, t.id('A'), t.id('c_full'), t.id('a_other')));
  perform t.ok('O4 pedido con direccion de OTRO cliente: rechazado', r like '23503%', r);
  r := t.try(format($q$insert into public.sales_orders(tenant_id, contact_id, sales_channel, shipping_address_id) values (%L, %L, 'portal', %L)$q$, t.id('A'), t.id('c_ship'), t.id('a_ship')));
  perform t.ok('O4b pedido con direccion propia: permitido', r = 'ok', r);
  r := t.try(format($q$update public.carts set contact_id = %L, shipping_address_id = %L where id = %L$q$, t.id('c_full'), t.id('a_other'), t.id('cart_bp')));
  perform t.ok('O4c carrito con direccion ajena: rechazado', r like '23503%', r);
  perform t.ok('O4d NO hay FK nueva sobre shipping_address_id: una sola FK sales_orders->contact_addresses por esa columna (embeds PostgREST sin ambiguedad)',
    (select count(*) from pg_constraint where conrelid = 'public.sales_orders'::regclass and confrelid = 'public.contact_addresses'::regclass
        and contype = 'f' and conkey = array[(select attnum from pg_attribute where attrelid = 'public.sales_orders'::regclass and attname = 'shipping_address_id')]) = 1
    and not exists (select 1 from pg_constraint where conrelid in ('public.sales_orders'::regclass, 'public.carts'::regclass)
        and confrelid = 'public.contact_addresses'::regclass and contype = 'f' and cardinality(conkey) > 1)
    and (select count(*) from pg_constraint where conrelid = 'public.sales_orders'::regclass and confrelid = 'public.contact_addresses'::regclass and contype = 'f') = 2);
  -- cambio de cliente: limpieza vs error
  insert into public.sales_orders(tenant_id, contact_id, sales_channel, shipping_address_id) values (t.id('A'), t.id('c_ship'), 'portal', t.id('a_ship')) returning id into o;
  r := t.try(format($q$update public.sales_orders set contact_id = %L where id = %L$q$, t.id('c_full'), o));
  perform t.ok('O4d2 cambiar solo el cliente: la direccion del cliente anterior se pone en NULL', r = 'ok' and (select shipping_address_id from public.sales_orders where id = o) is null, r);
  update public.sales_orders set contact_id = t.id('c_ship') where id = o;
  r := t.try(format($q$update public.sales_orders set contact_id = %L, shipping_address_id = %L where id = %L$q$, t.id('c_full'), t.id('a_ship'), o));
  perform t.ok('O4d3 cambiar cliente Y fijar direccion ajena en la misma sentencia: ERROR 23503 SHIPPING_ADDRESS_OWNER', r like '23503%SHIPPING_ADDRESS_OWNER%', r);
  r := t.try(format($q$update public.sales_orders set contact_id = %L, shipping_address_id = %L where id = %L$q$, t.id('c_full'), t.id('a_full_1'), o));
  perform t.ok('O4d4 cambiar cliente Y fijar direccion del nuevo cliente: ok', r = 'ok', r);
  insert into public.carts(tenant_id, origin, contact_id, shipping_address_id) values (t.id('A'), 'portal', t.id('c_ship'), t.id('a_ship')) returning id into v2;
  r := t.try(format($q$update public.carts set contact_id = %L where id = %L$q$, t.id('c_full'), v2));
  perform t.ok('O4d5 carrito: cambiar cliente limpia la direccion ajena', r = 'ok' and (select shipping_address_id from public.carts where id = v2) is null, r);
  insert into public.contact_addresses(tenant_id, contact_id, line1) values (t.id('A'), t.id('c_ship'), 'Calle Efimera 1') returning id into v2;
  insert into public.sales_orders(tenant_id, contact_id, sales_channel, shipping_address_id) values (t.id('A'), t.id('c_ship'), 'portal', v2) returning id into o;
  delete from public.contact_addresses where id = v2;
  perform t.ok('O4e borrar fisicamente la direccion deja shipping_address_id en NULL (semantica previa)',
    (select shipping_address_id from public.sales_orders where id = o) is null);

  -- O5 correcciones de destino (append-only)
  insert into public.sales_order_shipping_corrections(tenant_id, order_id, corrected_by, reason, previous_shipping_address_id, previous_shipping_snapshot)
    values (t.id('A'), t.id('o_portal'), t.id('uA'), 'Cliente cambio de direccion', t.id('a_ship'), '{"line1":"vieja"}');
  perform t.ok('O5 correccion registrada', (select count(*) from public.sales_order_shipping_corrections) = 1);
  r := t.try(format($q$insert into public.sales_order_shipping_corrections(tenant_id, order_id, reason) values (%L, %L, '  ')$q$, t.id('A'), t.id('o_portal')));
  perform t.ok('O5b motivo en blanco: rechazado', r like '23514%', r);
  r := t.try(format($q$insert into public.sales_order_shipping_corrections(tenant_id, order_id, reason) values (%L, %L, 'x')$q$, t.id('B'), t.id('o_portal')));
  perform t.ok('O5c correccion con tenant distinto al del pedido: rechazada por FK compuesta', r like '23503%', r);
  perform t.ok('O5d usuario de A la ve; usuario de B no',
    t.count_as('authenticated', t.id('uA'), 'select 1 from public.sales_order_shipping_corrections') = 1
    and t.count_as('authenticated', t.id('uB'), 'select 1 from public.sales_order_shipping_corrections') = 0);
  r := t.try_as('authenticated', t.id('uA'), $q$update public.sales_order_shipping_corrections set reason = 'alterado'$q$);
  perform t.ok('O5e append-only: update desde la app no cambia nada', (select reason from public.sales_order_shipping_corrections) = 'Cliente cambio de direccion', r);
  r := t.try_as('authenticated', t.id('uA'), $q$delete from public.sales_order_shipping_corrections$q$);
  perform t.ok('O5f append-only: delete desde la app no borra', (select count(*) from public.sales_order_shipping_corrections) = 1, r);
  r := t.try_as('authenticated', t.id('uA'), format($q$insert into public.sales_order_shipping_corrections(tenant_id, order_id, corrected_by, reason) values (%L, %L, %L, 'falsificada')$q$, t.id('A'), t.id('o_portal'), t.id('uAdmin')));
  perform t.ok('O5i un agente NO puede registrar una correccion a nombre de otra persona (corrected_by <> auth.uid()): 42501', r like '42501%', r);
  r := t.try_as('authenticated', t.id('uA'), format($q$insert into public.sales_order_shipping_corrections(tenant_id, order_id, reason) values (%L, %L, 'sin autor')$q$, t.id('A'), t.id('o_portal')));
  perform t.ok('O5j correccion sin corrected_by desde la app: rechazada', r like '42501%', r);
  r := t.try_as('authenticated', t.id('uA'), format($q$insert into public.sales_order_shipping_corrections(tenant_id, order_id, corrected_by, reason) values (%L, %L, %L, 'propia')$q$, t.id('A'), t.id('o_portal'), t.id('uA')));
  perform t.ok('O5k correccion con corrected_by = auth.uid(): permitida', r = 'ok', r);
  delete from public.sales_order_shipping_corrections where reason = 'propia';
  r := t.try_as('authenticated', t.id('uA'), format($q$insert into public.sales_order_shipping_corrections(tenant_id, order_id, reason) values (%L, %L, 'x')$q$, t.id('B'), t.id('o_portal')));
  perform t.ok('O5g usuario de A no inserta correcciones en B (RLS)', r like '42501%', r);
  perform t.ok('O5h anon sin acceso', t.try_as('anon', null, 'select 1 from public.sales_order_shipping_corrections') like '42501%');

  -- O6 save_cart_lines con las claves nuevas
  perform t.mkcart('cart_s', 'portal', 'c_full');
  update public.carts set notes = 'nota original', shipping_address_id = t.id('a_full_1') where id = t.id('cart_s');
  res := public.save_cart_lines(t.id('cart_s'), t.id('A'),
     jsonb_build_object('billing_profile_id', bp_full, 'fulfillment_method', 'pickup'), '[]'::jsonb);
  perform t.ok('O6 patch con claves nuevas las guarda y las devuelve',
    res ->> 'billing_profile_id' = bp_full::text and res ->> 'fulfillment_method' = 'pickup');
  perform t.ok('O6b claves ausentes no tocan (notas y direccion intactas)',
    res ->> 'notes' = 'nota original' and res ->> 'shipping_address_id' = t.id('a_full_1')::text);
  res := public.save_cart_lines(t.id('cart_s'), t.id('A'), jsonb_build_object('notes', 'cambiada'), '[]'::jsonb);
  perform t.ok('O6c patch sin las claves nuevas las conserva',
    res ->> 'billing_profile_id' = bp_full::text and res ->> 'fulfillment_method' = 'pickup' and res ->> 'notes' = 'cambiada');
  res := public.save_cart_lines(t.id('cart_s'), t.id('A'), jsonb_build_object('billing_profile_id', null), '[]'::jsonb);
  perform t.ok('O6d null explicito limpia billing_profile_id', res -> 'billing_profile_id' = 'null'::jsonb);
  begin
    perform public.save_cart_lines(t.id('cart_s'), t.id('A'), jsonb_build_object('billing_profile_id', bp_other), '[]'::jsonb);
    r := 'ok';
  exception when others then r := sqlstate; end;
  perform t.ok('O6e perfil de otro cliente por save_cart_lines: rechazado (23503)', r = '23503', r);
  perform t.mkcart('cart_s_pos', 'pos');
  res := public.save_cart_lines(t.id('cart_s_pos'), t.id('A'), jsonb_build_object('fulfillment_method', 'delivery'), '[]'::jsonb);
  perform t.ok('O6f carrito POS: pedir delivery por save_cart_lines se fuerza a on_site', res ->> 'fulfillment_method' = 'on_site');
  begin
    perform public.save_cart_lines(t.id('cart_s'), t.id('A'), jsonb_build_object('fulfillment_method', null), '[]'::jsonb);
    r := 'ok';
  exception when others then r := sqlstate; end;
  perform t.ok('O6g fulfillment_method null explicito falla ruidoso (NOT NULL)', r = '23502', r);
  perform t.ok('O6h privilegios intactos: solo service_role ejecuta save_cart_lines',
    not has_function_privilege('anon', 'public.save_cart_lines(uuid,uuid,jsonb,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.save_cart_lines(uuid,uuid,jsonb,jsonb)', 'execute')
    and has_function_privilege('service_role', 'public.save_cart_lines(uuid,uuid,jsonb,jsonb)', 'execute'));
  perform t.ok('O6i firma y seguridad intactas (security invoker, search_path vacio)',
    (select not prosecdef and array_to_string(proconfig, ',') like '%search_path=""%' from pg_proc where proname = 'save_cart_lines'));

  -- O7 borrar un cliente (cascade) con pedidos que usan su perfil
  insert into public.clients(tenant_id, full_name, phone) values (t.id('A'), 'Efimero', '3999') returning id into v;
  insert into public.client_billing_profiles(tenant_id, client_id, label) values (t.id('A'), v, 'ef') returning id into v2;
  insert into public.sales_orders(tenant_id, contact_id, sales_channel, billing_profile_id) values (t.id('A'), v, 'portal', v2);
  r := t.try(format('delete from public.clients where id = %L', v));
  perform t.ok('O7 borrar un cliente arrastra perfiles y pedidos sin chocar con el FK del perfil', r = 'ok', r);
end $$;
