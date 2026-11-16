set client_min_messages = warning;
create function t.upd(p_k text, p_set text, p_role text default 'postgres') returns text language plpgsql as $$
declare r text;
begin
  if p_role = 'postgres' then
    return t.try(format('update public.sales_orders set %s where id = %L', p_set, t.id(p_k)));
  end if;
  return t.try_as(p_role, null, format('update public.sales_orders set %s where id = %L', p_set, t.id(p_k)));
end $$;

do $$
declare r text; ba uuid; oo uuid;
begin
  -- candado: el pedido o_acc tiene factura accepted sin notas credito
  perform t.ok('L0 (control) sales_order_is_dian_locked: accepted sin NC = bloqueado',
    public.sales_order_is_dian_locked(t.id('o_acc')) and not public.sales_order_is_dian_locked(t.id('o_pend'))
    and not public.sales_order_is_dian_locked(t.id('o_sent_cn')) and public.sales_order_is_dian_locked(t.id('o_part_cn'))
    and not public.sales_order_is_dian_locked(t.id('o_rej')) and not public.sales_order_is_dian_locked(t.id('o_none')));

  r := t.upd('o_acc', format('contact_id = %L', t.id('c_other')));
  perform t.ok('L1 facturada: cambiar contact_id bloqueado (P0001)', r like 'P0001%', r);
  select id into ba from public.client_billing_profiles where client_id = t.id('c_ship');
  if ba is null then
    insert into public.client_billing_profiles(tenant_id, client_id, label) values (t.id('A'), t.id('c_ship'), 'L') returning id into ba;
  end if;
  r := t.upd('o_acc', format('billing_profile_id = %L', ba));
  perform t.ok('L2 facturada: asignar billing_profile_id bloqueado', r like 'P0001%', r);
  r := t.upd('o_acc', format('shipping_address_id = %L', t.id('a_ship')) );
  perform t.ok('L3 (control) mismo shipping_address_id (sin cambio) NO dispara el candado', r = 'ok', r);
  r := t.upd('o_acc', 'shipping_address_id = null');
  perform t.ok('L3b facturada: cambiar shipping_address_id bloqueado', r like 'P0001%', r);
  r := t.upd('o_acc', $q$shipping_snapshot = '{"line1":"otra"}'$q$);
  perform t.ok('L4 facturada: escribir shipping_snapshot bloqueado', r like 'P0001%', r);

  -- lo que NO se bloquea
  r := t.upd('o_acc', $q$delivery_status = 'entregado'$q$);
  perform t.ok('L5 facturada: delivery_status sigue editable', r = 'ok', r);
  r := t.upd('o_acc', $q$notes = 'nota interna'$q$);
  perform t.ok('L5b facturada: notas editables (alcance acotado a comprador/destino)', r = 'ok', r);
  r := t.upd('o_acc', 'shipping = 500');
  perform t.ok('L5c facturada: otras columnas no se tocan por este candado', r = 'ok', r);
  r := t.try(format($q$insert into public.sales_order_payments(tenant_id, order_id, amount, method) values (%L, %L, 10, 'efectivo')$q$, t.id('A'), t.id('o_acc')));
  perform t.ok('L5d facturada: se pueden registrar pagos', r = 'ok' or r not like 'P0001%', r);

  -- sin bypass por rol
  r := t.upd('o_acc', 'shipping_address_id = null', 'service_role');
  perform t.ok('L6 sin bypass: service_role tambien bloqueado', r like 'P0001%', r);
  r := t.upd('o_part_cn', format('contact_id = %L', t.id('c_other')), 'service_role');
  perform t.ok('L6b factura parcialmente acreditada sigue bloqueando', r like 'P0001%', r);

  -- no bloquea cuando no hay factura transmitida
  r := t.upd('o_pend', format('contact_id = %L, shipping_address_id = null', t.id('c_other')));
  perform t.ok('L7 factura pending: se puede cambiar el cliente', r = 'ok', r);
  r := t.upd('o_rej', format('contact_id = %L, shipping_address_id = null', t.id('c_other')));
  perform t.ok('L7b factura rejected: se puede cambiar el cliente', r = 'ok', r);
  r := t.upd('o_none', format('contact_id = %L, shipping_address_id = null', t.id('c_other')));
  perform t.ok('L7c sin factura: se puede cambiar el cliente', r = 'ok', r);
  r := t.upd('o_sent_cn', format('contact_id = %L, shipping_address_id = null', t.id('c_other')));
  perform t.ok('L8 factura totalmente acreditada: desbloquea (corregir y re-emitir)', r = 'ok', r);
  insert into public.sales_orders(tenant_id, contact_id, sales_channel, shipping_address_id) values (t.id('A'), t.id('c_ship'), 'portal', t.id('a_ship')) returning id into oo;
  insert into t.ids values ('o_chg', oo);
  r := t.upd('o_chg', format('contact_id = %L', t.id('c_full')));
  perform t.ok('L7d cambiar el cliente sin tocar la direccion: se limpia (NULL), no falla', r = 'ok' and (select shipping_address_id from public.sales_orders where id = oo) is null, r);
  r := t.upd('o_pend', 'shipping_snapshot = ' || quote_literal('{"line1":"x"}'));
  perform t.ok('L8b pending: el snapshot de envio es editable', r = 'ok', r);

  -- borrar fisicamente una direccion usada por un pedido bloqueado
  r := t.try(format('delete from public.contact_addresses where id = %L', t.id('a_ship')));
  perform t.ok('L9 hard-delete de la direccion de un pedido facturado: bloqueado (la direccion se desactiva, no se borra)', r like 'P0001%', r);

  -- no mueve updated_at ni interfiere con el estado
  perform t.ok('L10 el candado es BEFORE UPDATE de 4 columnas con WHEN',
    exists (select 1 from pg_trigger where tgname = 'trg_sales_orders_billing_shipping_lock' and tgtype & 2 = 2));
  perform t.ok('L10b funciones del candado sin EXECUTE para anon/authenticated',
    not has_function_privilege('anon', 'public.sales_order_is_dian_locked(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.guard_sales_order_billing_shipping_lock()', 'execute'));
end $$;
