set client_min_messages = warning;
create function t.q(p_k text, p_c text, p_channel text, p_method text default 'delivery', p_bp uuid default null, p_snap jsonb default null, p_prod text default 'prod', p_qty numeric default 1) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.sales_orders(tenant_id, contact_id, sales_channel, fulfillment_method, billing_profile_id, shipping_snapshot, subtotal, total)
  values (t.id('A'), t.id(p_c), p_channel, p_method, p_bp, p_snap, 1000, 1000) returning id into v;
  insert into public.sales_order_items(tenant_id, order_id, product_id, product_name, quantity, unit_price, subtotal)
  values (t.id('A'), v, t.id(p_prod), p_prod, p_qty, 1000, 1000);
  insert into t.ids values (p_k, v); return v;
end $$;
create function t.confirm(p_k text) returns text language sql as
$$ select t.try(format('update public.sales_orders set status = ''confirmada'' where id = %L', t.id(p_k))) $$;
create function t.inv(p_k text) returns public.sales_invoices language sql stable as
$$ select i from public.sales_invoices i where i.order_id = t.id(p_k) order by attempt_number desc limit 1 $$;

do $$
declare r text; o public.sales_orders; i public.sales_invoices; bp2 uuid; bp_bad uuid; bp_geo uuid; n int;
begin
  insert into public.products(tenant_id, name, track_inventory) values (t.id('A'), 'scarce', true);
  insert into t.ids select 'scarce', id from public.products where tenant_id = t.id('A') and name = 'scarce';
  insert into public.product_stock(tenant_id, product_id, warehouse_id, quantity) values (t.id('A'), t.id('scarce'), t.id('A_w1'), 1);

  -- ===== guard: direccion segun fulfillment_method =====
  perform t.q('g1', 'c_noemail', 'portal', 'delivery');
  r := t.confirm('g1');
  perform t.ok('G1 delivery sin direccion ni snapshot: SHIPPING_ADDRESS_REQUIRED', r like '%SHIPPING_ADDRESS_REQUIRED%', r);
  perform t.ok('G1b ...y el pedido NO quedo confirmado', (select status from public.sales_orders where id = t.id('g1')) = 'cotizacion');

  perform t.q('g2', 'c_ship', 'portal', 'delivery');
  r := t.confirm('g2');
  select * into o from public.sales_orders where id = t.id('g2');
  perform t.ok('G2 delivery usa la direccion de envio predeterminada del cliente', r = 'ok' and o.shipping_address_id = t.id('a_ship'), r);
  perform t.ok('G2b shipping_snapshot congelado al confirmar',
    o.shipping_snapshot ->> 'line1' = 'Calle Envio 5' and o.shipping_snapshot ->> 'address_id' = t.id('a_ship')::text
    and o.shipping_snapshot ->> 'city_code' = '05001' and o.shipping_snapshot ->> 'recipient_name' = 'Dest a_ship'
    and o.shipping_snapshot ? 'frozen_at');
  update public.contact_addresses set line1 = 'Calle Cambiada 99' where id = t.id('a_ship');
  perform t.ok('G2c editar la libreta despues NO altera el snapshot del pedido',
    (select shipping_snapshot ->> 'line1' from public.sales_orders where id = t.id('g2')) = 'Calle Envio 5');
  update public.contact_addresses set line1 = 'Calle Envio 5' where id = t.id('a_ship');

  perform t.q('g3', 'c_noemail', 'portal', 'on_site');
  r := t.confirm('g3');
  select * into o from public.sales_orders where id = t.id('g3');
  perform t.ok('G3 on_site confirma sin direccion; sin snapshot', r = 'ok' and o.shipping_address_id is null and o.shipping_snapshot is null, r);
  perform t.q('g4', 'c_noemail', 'storefront', 'pickup');
  r := t.confirm('g4');
  select * into o from public.sales_orders where id = t.id('g4');
  perform t.ok('G4 pickup confirma sin direccion; sin snapshot', r = 'ok' and o.shipping_address_id is null and o.shipping_snapshot is null, r);

  -- stock: el salto de POS es explicito
  perform t.q('g5', 'c_noemail', 'portal', 'on_site', null, null, 'scarce', 5);
  r := t.confirm('g5');
  perform t.ok('G5 canal portal sin stock suficiente: INSUFFICIENT_STOCK', r like '%INSUFFICIENT_STOCK%', r);
  perform t.q('g5pos', 'c_noemail', 'pos', 'on_site', null, null, 'scarce', 5);
  r := t.confirm('g5pos');
  perform t.ok('G5b canal POS sigue saltando el chequeo duro de stock', r = 'ok', r);

  -- snapshot provisto sin direccion guardada
  perform t.q('g6', 'c_noemail', 'portal', 'delivery', null, '{"line1":"Destino puntual 3","city":"Cali"}');
  r := t.confirm('g6');
  perform t.ok('G6 delivery con shipping_snapshot propio (line1) y sin direccion guardada: confirma y lo conserva',
    r = 'ok' and (select shipping_snapshot ->> 'line1' from public.sales_orders where id = t.id('g6')) = 'Destino puntual 3', r);
  perform t.q('g7', 'c_noemail', 'portal', 'delivery', null, '{"city":"Cali"}');
  r := t.confirm('g7');
  perform t.ok('G7 snapshot sin line1 no sirve como destino', r like '%SHIPPING_ADDRESS_REQUIRED%', r);

  -- placeholder en la libreta
  insert into public.contact_addresses(tenant_id, contact_id, line1, is_shipping) values (t.id('A'), t.id('c_nodata'), 'Sin dirección registrada', true);
  perform t.q('g8', 'c_nodata', 'portal', 'delivery');
  r := t.confirm('g8');
  perform t.ok('G8 direccion placeholder no cuenta como destino', r like '%SHIPPING_ADDRESS_REQUIRED%', r);

  -- con direccion elegida a mano: se congela esa
  perform t.q('g9', 'c_full', 'portal', 'delivery');
  update public.sales_orders set shipping_address_id = t.id('a_full_dup') where id = t.id('g9');
  r := t.confirm('g9');
  perform t.ok('G9 direccion elegida explicitamente: se congela esa (no la predeterminada)',
    r = 'ok' and (select shipping_snapshot ->> 'address_id' from public.sales_orders where id = t.id('g9')) = t.id('a_full_dup')::text, r);

  perform t.ok('G10 ACL del guard: ni anon ni authenticated pueden ejecutarlo',
    not has_function_privilege('anon', 'public.guard_sales_order_confirmation()', 'execute')
    and not has_function_privilege('authenticated', 'public.guard_sales_order_confirmation()', 'execute'));
  perform t.ok('G10b el trigger del guard sigue siendo BEFORE UPDATE OF status',
    exists (select 1 from pg_trigger where tgname = 'trg_sales_orders_confirm_guard' and tgtype & 2 = 2 and tgtype & 16 = 16));

  -- ===== efectos: snapshot del comprador desde el perfil =====
  insert into public.client_billing_profiles(tenant_id, client_id, label, document_type_code, document_number, legal_name, email,
       organization_type, tax_scheme_code, address_line1, country, state_code, city_code, city)
    values (t.id('A'), t.id('c_full'), 'Otra razon', '31', '800555444', 'Otra Razon SAS', 'otra@x.co', '1', '04', 'Av 5', 'CO', '11', '11001', 'Bogotá')
    returning id into bp2;
  perform t.q('e1', 'c_full', 'pos', 'on_site', bp2);
  r := t.confirm('e1'); i := t.inv('e1');
  perform t.ok('E1 factura reservada con el perfil ELEGIDO en el pedido',
    r = 'ok' and i.buyer_snapshot ->> 'billing_profile_id' = bp2::text and i.buyer_snapshot ->> 'full_name' = 'Otra Razon SAS'
    and i.buyer_snapshot ->> 'document_number' = '800555444' and i.buyer_snapshot ->> 'tax_scheme_code' = '04'
    and i.buyer_snapshot #>> '{address,line1}' = 'Av 5' and i.buyer_snapshot #>> '{address,city_code}' = '11001', r || ' ' || coalesce(i.buyer_snapshot::text, 'sin factura'));
  perform t.ok('E1b estado pending (perfil completo)', i.status = 'pending' and i.status_detail is null, i.status || ' ' || coalesce(i.status_detail, ''));

  perform t.q('e2', 'c_full', 'pos', 'on_site');
  r := t.confirm('e2'); i := t.inv('e2');
  perform t.ok('E2 sin billing_profile_id: usa el perfil PREDETERMINADO del cliente',
    i.buyer_snapshot ->> 'full_name' = 'Acme SAS' and i.buyer_snapshot ->> 'email' = 'fact@acme.co' and i.buyer_snapshot ->> 'organization_type' = '1'
    and i.buyer_snapshot ->> 'tax_level_code' = 'O-13', coalesce(i.buyer_snapshot::text, 'sin factura'));
  perform t.ok('E2b la factura copia los items del pedido', (select count(*) from public.sales_invoice_items where invoice_id = i.id) = 1);

  perform t.q('e3', 'c_noemail', 'pos', 'on_site');
  r := t.confirm('e3'); i := t.inv('e3');
  perform t.ok('E3 perfil sin correo: blocked_missing_buyer_data con "correo de facturación"',
    i.status = 'blocked_missing_buyer_data' and i.status_detail like '%correo de facturación%', i.status || ' ' || coalesce(i.status_detail, ''));

  -- B1/B2: el walk-in NO usa respaldo desde clients. Aunque la ficha compartida tenga correo,
  -- el snapshot NO lo copia: queda bloqueado por "correo de facturación" (llega por comprobante).
  update public.clients set email = 'ficha@walkin.co' where id = t.id('A_walkin');
  perform t.q('e4', 'A_walkin', 'pos', 'on_site');
  r := t.confirm('e4'); i := t.inv('e4');
  perform t.ok('E4 Consumidor Final: doc 222222222222, SIN correo de la ficha, blocked "correo de facturación", sin billing_profile_id',
    i.status = 'blocked_missing_buyer_data' and i.status_detail like '%correo de facturación%' and i.buyer_snapshot ->> 'client_id' = t.id('A_walkin')::text
    and not (i.buyer_snapshot ? 'billing_profile_id') and i.buyer_snapshot ->> 'document_number' = '222222222222'
    and i.buyer_snapshot ->> 'email' is null, i.status || ' ' || coalesce(i.status_detail, '') || ' ' || coalesce(i.buyer_snapshot::text, ''));

  perform t.q('e5', 'c_belen', 'pos', 'on_site');
  r := t.confirm('e5'); i := t.inv('e5');
  perform t.ok('E5 domicilio CO sin DIVIPOLA: blocked "departamento y municipio"',
    i.status = 'blocked_missing_buyer_data' and i.status_detail like '%departamento y municipio%', i.status || ' ' || coalesce(i.status_detail, ''));

  perform t.q('e6', 'c_nodata', 'pos', 'on_site');
  r := t.confirm('e6'); i := t.inv('e6');
  perform t.ok('E6 cliente (no walk-in) sin perfil: blocked "perfil de facturación", sin documento/correo desde clients',
    i.status = 'blocked_missing_buyer_data' and i.status_detail = 'Falta: perfil de facturación'
    and i.buyer_snapshot ->> 'document_number' is null and i.buyer_snapshot ->> 'email' is null, i.status || ' ' || coalesce(i.status_detail, '') || ' ' || coalesce(i.buyer_snapshot::text, ''));

  insert into public.client_billing_profiles(tenant_id, client_id, label, document_type_code, document_number, legal_name, email)
    values (t.id('A'), t.id('c_other'), 'Mal correo', '13', '99999', 'Otro Mal', 'esto-no-es-un-correo') returning id into bp_bad;
  perform t.q('e7', 'c_other', 'pos', 'on_site', bp_bad);
  r := t.confirm('e7'); i := t.inv('e7');
  perform t.ok('E7 correo con formato invalido: "correo de facturación válido"',
    i.status = 'blocked_missing_buyer_data' and i.status_detail like '%correo de facturación válido%', i.status_detail);

  perform t.q('e8', 'c_foreign', 'pos', 'on_site');
  r := t.confirm('e8'); i := t.inv('e8');
  perform t.ok('E8 extranjero con domicilio US: pending sin exigir DIVIPOLA',
    i.status = 'pending' and i.buyer_snapshot #>> '{address,country}' = 'US', i.status || ' ' || coalesce(i.status_detail, ''));

  -- un perfil soft-deleted elegido explicitamente sigue sirviendo (pedido ya tomo esa decision)
  update public.client_billing_profiles set deleted_at = now() where id = bp2;
  perform t.q('e9', 'c_full', 'pos', 'on_site', bp2);
  r := t.confirm('e9'); i := t.inv('e9');
  perform t.ok('E9 perfil elegido en el pedido y luego eliminado: se sigue usando', i.buyer_snapshot ->> 'billing_profile_id' = bp2::text);

  -- tenant sin credencial DIAN: no se reserva factura
  update public.integration_credentials set is_active = false where tenant_id = t.id('A');
  perform t.q('e10', 'c_full', 'pos', 'on_site');
  r := t.confirm('e10');
  perform t.ok('E10 sin dian_directo activo: confirma y no reserva factura', r = 'ok' and not exists (select 1 from public.sales_invoices where order_id = t.id('e10')));
  update public.integration_credentials set is_active = true where tenant_id = t.id('A');

  perform t.ok('E11 no hay advertencias silenciadas: todas las ventas confirmadas reservaron factura (e1-e9)',
    (select count(*) from public.sales_invoices where order_id in (select id from t.ids where k in ('e1','e2','e3','e4','e5','e6','e7','e8','e9'))) = 9);
end $$;
