set client_min_messages = warning;
create function t.q(p_k text, p_c text, p_channel text, p_method text default 'delivery', p_bp uuid default null, p_snap jsonb default null) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.sales_orders(tenant_id, contact_id, sales_channel, fulfillment_method, billing_profile_id, shipping_snapshot, subtotal, total)
  values (t.id('A'), t.id(p_c), p_channel, p_method, p_bp, p_snap, 1000, 1000) returning id into v;
  insert into public.sales_order_items(tenant_id, order_id, product_id, product_name, quantity, unit_price, subtotal)
  values (t.id('A'), v, t.id('prod'), 'prod', 1, 1000, 1000);
  insert into t.ids values (p_k, v); return v;
end $$;
create function t.confirm(p_k text) returns text language sql as
$$ select t.try(format('update public.sales_orders set status = ''confirmada'' where id = %L', t.id(p_k))) $$;
create function t.inv(p_k text) returns public.sales_invoices language sql stable as
$$ select i from public.sales_invoices i where i.order_id = t.id(p_k) order by attempt_number desc limit 1 $$;
create function t.corr(p_order text, p_addr text, p_reason text, p_by uuid, p_dest jsonb default null) returns text language sql as
$$ select t.try(format('select public.correct_order_shipping(%L, %L, %s, %L, %L, %L)', t.id('A'), t.id(p_order),
     case when p_addr is null then 'null' else quote_literal(t.id(p_addr)) end, p_reason, p_by, p_dest)) $$;

do $$
declare r text; i public.sales_invoices; o public.sales_orders; bp uuid; n int; admin uuid := t.id('uAdmin'); res jsonb; cid uuid;
begin
  -- ===== B1 en base: el walk-in no admite perfiles =====
  r := t.try(format($q$insert into public.client_billing_profiles(tenant_id, client_id, label, document_type_code, document_number, legal_name, email)
       values (%L, %L, 'X', '31', '900999888', 'Tercero SA', 'tercero@x.co')$q$, t.id('A'), t.id('A_walkin')));
  perform t.ok('W1 crear un perfil bajo el walk-in: rechazado (23514 WALK_IN_NO_BILLING_PROFILE)', r like '23514%WALK_IN_NO_BILLING_PROFILE%', r);
  r := t.try(format($q$update public.client_billing_profiles set client_id = %L where client_id = %L$q$, t.id('A_walkin'), t.id('c_full')));
  perform t.ok('W2 mover un perfil existente al walk-in: rechazado', r like '23514%', r);
  r := t.try(format($q$insert into public.client_billing_profiles(tenant_id, client_id, label) values (%L, %L, 'ok-ctrl')$q$, t.id('A'), t.id('c_other')));
  perform t.ok('W3 un cliente normal sigue pudiendo tener perfiles (control)', r = 'ok', r);
  select count(*) into n from public.client_billing_profiles where client_id = t.id('A_walkin');
  perform t.ok('W4 el walk-in no tiene ningun perfil', n = 0);

  -- ===== B1 en efectos SQL: aunque exista (forzado) un perfil predeterminado bajo el walk-in, NO se usa =====
  alter table public.client_billing_profiles disable trigger client_billing_profiles_no_walk_in;
  insert into public.client_billing_profiles(tenant_id, client_id, label, document_type_code, document_number, legal_name, email)
    values (t.id('A'), t.id('A_walkin'), 'Tercero', '31', '900999888', 'Tercero SA', 'tercero@x.co') returning id into bp;
  alter table public.client_billing_profiles enable trigger client_billing_profiles_no_walk_in;
  update public.clients set email = 'ficha@walkin.co' where id = t.id('A_walkin');
  perform t.q('w1', 'A_walkin', 'pos', 'on_site');
  r := t.confirm('w1'); i := t.inv('w1');
  perform t.ok('W5 walk-in con perfil predeterminado forzado: el SQL NO lo toma (doc 222222222222, sin correo, pending)',
    i.buyer_snapshot ->> 'document_number' = '222222222222' and i.buyer_snapshot ->> 'email' is null
    and not (i.buyer_snapshot ? 'billing_profile_id') and i.status = 'pending', coalesce(i.buyer_snapshot::text, 'sin factura'));
  delete from public.client_billing_profiles where id = bp;

  -- ===== M3: correct_order_shipping atomica =====
  perform t.addr('a_ship2', 'A', 'c_ship', 'Calle Nueva 9', true, false, false);
  perform t.q('s1', 'c_ship', 'portal', 'delivery');
  r := t.confirm('s1');
  perform t.ok('S0 (control) pedido a domicilio confirmado con la direccion predeterminada', r = 'ok' and (select shipping_address_id from public.sales_orders where id = t.id('s1')) = t.id('a_ship'), r);

  r := t.corr('s1', 'a_ship2', '  cliente corrigio la calle  ', admin);
  select * into o from public.sales_orders where id = t.id('s1');
  perform t.ok('S1 corregir: actualiza direccion y re-congela el snapshot',
    r = 'ok' and o.shipping_address_id = t.id('a_ship2') and o.shipping_snapshot ->> 'line1' = 'Calle Nueva 9' and o.shipping_snapshot ->> 'address_id' = t.id('a_ship2')::text, r);
  perform t.ok('S1b ...y deja EXACTAMENTE una fila de auditoria con autor, motivo (sin espacios) y valor anterior',
    (select count(*) from public.sales_order_shipping_corrections where order_id = t.id('s1')) = 1
    and exists (select 1 from public.sales_order_shipping_corrections c where c.order_id = t.id('s1') and c.corrected_by = admin and c.reason = 'cliente corrigio la calle'
        and c.previous_shipping_address_id = t.id('a_ship') and c.previous_shipping_snapshot ->> 'line1' = 'Calle Envio 5'
        and c.new_shipping_address_id = t.id('a_ship2') and c.new_shipping_snapshot ->> 'line1' = 'Calle Nueva 9'));

  r := t.corr('s1', 'a_other', 'direccion ajena', admin);
  perform t.ok('S2 direccion de OTRO cliente: 23503 y nada cambia',
    r like '23503%' and (select shipping_address_id from public.sales_orders where id = t.id('s1')) = t.id('a_ship2')
    and (select count(*) from public.sales_order_shipping_corrections where order_id = t.id('s1')) = 1, r);
  r := t.corr('s1', 'a_ship', '   ', admin);
  perform t.ok('S3 motivo vacio: rechazado (22023)', r like '22023%REASON_REQUIRED%', r);
  r := t.corr('s1', null, 'quitar destino', admin);
  perform t.ok('S4 quitar el destino de un pedido a domicilio: rechazado', r like '22023%SHIPPING_ADDRESS_REQUIRED%', r);
  perform t.q('s2', 'c_ship', 'portal', 'delivery');
  r := t.corr('s2', 'a_ship2', 'aun cotizacion', admin);
  perform t.ok('S5 pedido en cotizacion: rechazado (LX409)', r like 'LX409%', r);
  r := t.corr('o_acc', 'a_ship2', 'facturado', admin);
  perform t.ok('S6 pedido con factura aceptada: el candado de la base lo bloquea (P0001) y no queda auditoria',
    r like 'P0001%' and not exists (select 1 from public.sales_order_shipping_corrections where order_id = t.id('o_acc')), r);

  -- atomicidad: la auditoria falla (corrected_by inexistente => FK) => el UPDATE del pedido se revierte
  r := t.corr('s1', 'a_ship', 'prueba atomicidad', gen_random_uuid());
  perform t.ok('S7 ATOMICIDAD: si la auditoria falla, el pedido NO queda cambiado',
    r like '23503%' and (select shipping_address_id from public.sales_orders where id = t.id('s1')) = t.id('a_ship2')
    and (select count(*) from public.sales_order_shipping_corrections where order_id = t.id('s1')) = 1, r);

  -- ===== Ronda 3: destino de UN SOLO USO =====
  -- guard: un pedido a domicilio con snapshot propio y SIN direccion de libreta se
  -- respeta aunque el cliente tenga una predeterminada (no se reemplaza).
  perform t.q('d1', 'c_ship', 'portal', 'delivery', null, '{"line1":"Destino puntual 7","city":"Cali","recipient_name":"Ana"}');
  r := t.confirm('d1');
  select * into o from public.sales_orders where id = t.id('d1');
  perform t.ok('D1 guard: delivery con shipping_snapshot propio conserva ESE destino (no la predeterminada) y shipping_address_id sigue null',
    r = 'ok' and o.shipping_address_id is null and o.shipping_snapshot ->> 'line1' = 'Destino puntual 7' and o.shipping_snapshot ->> 'recipient_name' = 'Ana', r || ' ' || coalesce(o.shipping_snapshot::text, ''));
  perform t.q('d2', 'c_ship', 'portal', 'delivery', null, '{"city":"Cali"}');
  r := t.confirm('d2');
  select * into o from public.sales_orders where id = t.id('d2');
  perform t.ok('D2 snapshot SIN line1 no cuenta como destino propio: cae a la predeterminada del cliente', r = 'ok' and o.shipping_address_id = t.id('a_ship'), r);

  -- carts.shipping_snapshot + save_cart_lines
  insert into public.carts(tenant_id, contact_id, origin) values (t.id('A'), t.id('c_ship'), 'portal') returning id into cid;
  insert into t.ids values ('cart_d', cid);
  res := public.save_cart_lines(cid, t.id('A'), jsonb_build_object('shipping_snapshot', jsonb_build_object('line1', 'Destino carrito 1', 'one_off', true), 'shipping_address_id', null), '[]'::jsonb);
  perform t.ok('D3 save_cart_lines guarda y devuelve shipping_snapshot', res #>> '{shipping_snapshot,line1}' = 'Destino carrito 1', res::text);
  res := public.save_cart_lines(cid, t.id('A'), jsonb_build_object('notes', 'otra'), '[]'::jsonb);
  perform t.ok('D3b clave ausente no toca el snapshot', res #>> '{shipping_snapshot,line1}' = 'Destino carrito 1' and res ->> 'notes' = 'otra');
  res := public.save_cart_lines(cid, t.id('A'), jsonb_build_object('shipping_snapshot', null), '[]'::jsonb);
  perform t.ok('D3c null explicito limpia el snapshot', res -> 'shipping_snapshot' is null or res ->> 'shipping_snapshot' is null, res::text);
  r := t.try(format($q$update public.carts set shipping_snapshot = '[1]'::jsonb where id = %L$q$, cid));
  perform t.ok('D3d el snapshot del carrito debe ser un objeto (CHECK)', r like '23514%', r);
  perform t.ok('D3e ACL de save_cart_lines intacta tras 129000',
    not has_function_privilege('anon', 'public.save_cart_lines(uuid,uuid,jsonb,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.save_cart_lines(uuid,uuid,jsonb,jsonb)', 'execute')
    and has_function_privilege('service_role', 'public.save_cart_lines(uuid,uuid,jsonb,jsonb)', 'execute'));

  -- correct_order_shipping con destino puntual
  perform t.q('d3', 'c_ship', 'portal', 'delivery');
  r := t.confirm('d3');
  r := t.corr('d3', null, 'entrega en otro lugar', admin, '{"line1":"Bodega del cliente 5","city":"Bogotá","phone":"3000000000"}'::jsonb);
  select * into o from public.sales_orders where id = t.id('d3');
  perform t.ok('D4 corregir con destino puntual: address null + snapshot propio + auditoria con el snapshot nuevo',
    r = 'ok' and o.shipping_address_id is null and o.shipping_snapshot ->> 'line1' = 'Bodega del cliente 5' and (o.shipping_snapshot ->> 'one_off')::boolean
    and exists (select 1 from public.sales_order_shipping_corrections c where c.order_id = t.id('d3') and c.previous_shipping_address_id = t.id('a_ship')
         and c.new_shipping_address_id is null and c.new_shipping_snapshot ->> 'line1' = 'Bodega del cliente 5'), r);
  r := t.corr('d3', null, 'sin linea', admin, '{"city":"Bogotá"}'::jsonb);
  perform t.ok('D5 destino puntual sin line1: rechazado (22023) y nada cambia', r like '22023%' and (select shipping_snapshot ->> 'line1' from public.sales_orders where id = t.id('d3')) = 'Bodega del cliente 5', r);

  perform t.ok('S8 ACL: solo service_role ejecuta correct_order_shipping',
    not has_function_privilege('anon', 'public.correct_order_shipping(uuid,uuid,uuid,text,uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.correct_order_shipping(uuid,uuid,uuid,text,uuid,jsonb)', 'execute')
    and has_function_privilege('service_role', 'public.correct_order_shipping(uuid,uuid,uuid,text,uuid,jsonb)', 'execute'));
  perform t.ok('S8b security definer con search_path vacio',
    exists (select 1 from pg_proc where proname = 'correct_order_shipping' and prosecdef and proconfig @> array['search_path=""']));
end $$;
