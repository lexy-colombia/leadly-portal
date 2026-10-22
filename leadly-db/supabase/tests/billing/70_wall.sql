-- ST3 / D7: muro de pago. Un tenant bloqueado POR MORA lee SUS comprobantes/items/intentos y nada mas;
-- aislamiento entre tenants; bloqueo manual no abre nada; sin escritura; tenant activo y superadmin intactos.
set client_min_messages = warning;
select t.setclock('2026-10-20 08:00:00-05');
select t.tenant(k) from unnest(array['A','B','C','M','S']) k;
-- A: bloqueado por mora; C: bloqueado por mora (otro); B: activo; M: bloqueado a mano; S: usuario sin tenant (superadmin)
update public.tenants set status = 'inactive', suspension_reason = 'nonpayment', suspended_at = now() where id in (t.id('A'), t.id('C'));
update public.tenants set status = 'inactive' where id = t.id('M');
insert into public.profiles(id, tenant_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', null, 'superadmin'),
  ('00000000-0000-0000-0000-0000000000c1', t.id('A'), 'tenant_admin'),
  ('00000000-0000-0000-0000-0000000000c2', t.id('A'), 'tenant_agent'),
  ('00000000-0000-0000-0000-0000000000c3', t.id('B'), 'tenant_admin'),
  ('00000000-0000-0000-0000-0000000000c4', t.id('C'), 'tenant_admin'),
  ('00000000-0000-0000-0000-0000000000c5', t.id('M'), 'tenant_admin');
\set SU '00000000-0000-0000-0000-0000000000a1'
\set UA '00000000-0000-0000-0000-0000000000c1'
\set UA2 '00000000-0000-0000-0000-0000000000c2'
\set UB '00000000-0000-0000-0000-0000000000c3'
\set UC '00000000-0000-0000-0000-0000000000c4'
\set UM '00000000-0000-0000-0000-0000000000c5'
-- 2 comprobantes por tenant (uno pendiente vencido, uno pagado) con 1 item y 1 intento cada uno
create function t.seed(p_k text) returns void language plpgsql as $$
declare v uuid; i int;
begin
  for i in 1..2 loop
    v := t.mk_inv(t.id(p_k), date '2026-10-01', case when i = 1 then 'PENDING' else 'PAID' end);
    insert into public.payment_invoice_items(invoice_id, description, unit_price_cents, subtotal_cents) values (v, 'item ' || p_k, 1000000, 1000000);
    insert into public.payment_attempts(invoice_id, provider_key, status, amount_cents) values (v, 'wompi', 'APPROVED', 1000000);
  end loop;
end $$;
select t.seed(k) from unnest(array['A','B','C','M']) k;
-- uno anulado (soft-delete) de A: se ve igual que hoy para un activo (la funcion lo rechaza aparte)
update public.payment_invoices set deleted_at = now() where id = (select id from public.payment_invoices where payer_tenant_id = t.id('A') and status = 'PAID' limit 1);

-- cuenta filas visibles para un rol/usuario (-1 si la consulta falla)
create function t.cnt(p_role text, p_uid uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', case when p_role is null then '' else json_build_object('role', p_role, 'sub', p_uid)::text end, true);
  if p_role in ('anon', 'authenticated', 'service_role') then execute format('set local role %I', p_role); end if;
  begin execute 'select count(*) from (' || p_sql || ') q' into n; exception when others then n := -1; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return n;
end $$;
-- filas afectadas por una escritura (-1 si falla)
create function t.wr(p_role text, p_uid uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', case when p_role is null then '' else json_build_object('role', p_role, 'sub', p_uid)::text end, true);
  if p_role in ('anon', 'authenticated', 'service_role') then execute format('set local role %I', p_role); end if;
  begin execute p_sql; get diagnostics n = row_count; exception when others then n := -1; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return n;
end $$;
create function t.q(p_t text, p_k text) returns text language sql as $$
  select case p_t
    when 'inv' then format('select * from public.payment_invoices where payer_tenant_id = %L', t.id(p_k))
    when 'items' then format('select it.* from public.payment_invoice_items it join public.payment_invoices i on i.id = it.invoice_id where i.payer_tenant_id = %L', t.id(p_k))
    when 'att' then format('select a.* from public.payment_attempts a join public.payment_invoices i on i.id = a.invoice_id where i.payer_tenant_id = %L', t.id(p_k))
  end $$;

-- ------------------------------------------------------------ helper
select t.chk('W0 estado: A y C bloqueados por mora, M a mano, B activo',
  (select count(*) from public.tenants where id in (t.id('A'), t.id('C')) and suspension_reason = 'nonpayment' and status = 'inactive') = 2
  and (select suspension_reason is null and status = 'inactive' from public.tenants where id = t.id('M')));
create function t.helper(p_role text, p_uid uuid) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', case when p_role is null then '' else json_build_object('role', p_role, 'sub', p_uid)::text end, true);
  if p_role in ('anon', 'authenticated', 'service_role') then execute format('set local role %I', p_role); end if;
  begin execute 'select coalesce(public.auth_nonpayment_tenant_id()::text, ''NULL'')' into r; exception when others then r := 'ERR:' || sqlerrm; end;
  reset role; perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
select t.chk('H1 helper: usuario de A (mora) -> id de A; el agente de A tambien', t.helper('authenticated', :'UA') = t.id('A')::text and t.helper('authenticated', :'UA2') = t.id('A')::text);
select t.chk('H2 helper: usuario de C (mora) -> id de C (no el de A)', t.helper('authenticated', :'UC') = t.id('C')::text);
select t.chk('H3 helper: NULL para tenant activo (B), bloqueo manual (M), superadmin sin tenant y usuario inexistente',
  t.helper('authenticated', :'UB') = 'NULL' and t.helper('authenticated', :'UM') = 'NULL' and t.helper('authenticated', :'SU') = 'NULL'
  and t.helper('authenticated', '00000000-0000-0000-0000-0000000000ff') = 'NULL');
select t.chk('H4 helper: anon no puede ejecutarlo (permission denied)', t.helper('anon', null) like 'ERR:%permission denied%', t.helper('anon', null));
select t.chk('H5 helper: sin claims (pg_cron / postgres) -> NULL', t.helper(null, null) = 'NULL');
select t.chk('H6 helper: PUBLIC sin EXECUTE; authenticated y service_role con EXECUTE',
  not has_function_privilege('anon', 'public.auth_nonpayment_tenant_id()', 'execute')
  and has_function_privilege('authenticated', 'public.auth_nonpayment_tenant_id()', 'execute')
  and has_function_privilege('service_role', 'public.auth_nonpayment_tenant_id()', 'execute'));

-- ------------------------------------------------------------ lectura del bloqueado por mora
select t.chk('L1 usuario de A (mora) lee sus 2 comprobantes (incluido el anulado, igual que un activo)', t.cnt('authenticated', :'UA', t.q('inv', 'A')) = 2);
select t.chk('L2 ... sus 2 items y sus 2 intentos', t.cnt('authenticated', :'UA', t.q('items', 'A')) = 2 and t.cnt('authenticated', :'UA', t.q('att', 'A')) = 2);
select t.chk('L3 el agente de A (mora) ve lo mismo', t.cnt('authenticated', :'UA2', t.q('inv', 'A')) = 2);
select t.chk('L4 el bloqueado por mora NO lee los comprobantes/items/intentos de B (activo), C (mora) ni M (manual)',
  t.cnt('authenticated', :'UA', t.q('inv', 'B')) = 0 and t.cnt('authenticated', :'UA', t.q('inv', 'C')) = 0 and t.cnt('authenticated', :'UA', t.q('inv', 'M')) = 0
  and t.cnt('authenticated', :'UA', t.q('items', 'B')) = 0 and t.cnt('authenticated', :'UA', t.q('items', 'C')) = 0 and t.cnt('authenticated', :'UA', t.q('items', 'M')) = 0
  and t.cnt('authenticated', :'UA', t.q('att', 'B')) = 0 and t.cnt('authenticated', :'UA', t.q('att', 'C')) = 0 and t.cnt('authenticated', :'UA', t.q('att', 'M')) = 0);
select t.chk('L5 sin filtro: el bloqueado por mora ve EXACTAMENTE 2 comprobantes, 2 items y 2 intentos en total (nada ajeno)',
  t.cnt('authenticated', :'UA', 'select * from public.payment_invoices') = 2
  and t.cnt('authenticated', :'UA', 'select * from public.payment_invoice_items') = 2
  and t.cnt('authenticated', :'UA', 'select * from public.payment_attempts') = 2);
select t.chk('L6 simetria: C (mora) ve solo lo suyo', t.cnt('authenticated', :'UC', 'select * from public.payment_invoices') = 2
  and t.cnt('authenticated', :'UC', t.q('inv', 'A')) = 0);
select t.chk('L7 bloqueado a MANO (reason null) no lee NADA, ni lo suyo',
  t.cnt('authenticated', :'UM', 'select * from public.payment_invoices') = 0
  and t.cnt('authenticated', :'UM', 'select * from public.payment_invoice_items') = 0
  and t.cnt('authenticated', :'UM', 'select * from public.payment_attempts') = 0);
select t.chk('L8 tenant ACTIVO: igual que hoy (2 comprobantes suyos, 2 items, 2 intentos, sin duplicados)',
  t.cnt('authenticated', :'UB', 'select * from public.payment_invoices') = 2
  and t.cnt('authenticated', :'UB', 'select * from public.payment_invoice_items') = 2
  and t.cnt('authenticated', :'UB', 'select * from public.payment_attempts') = 2
  and (select count(distinct id) from (select id from public.payment_invoices where payer_tenant_id = t.id('B')) x) = 2);
select t.chk('L9 anon no lee nada (permission denied o 0)', t.cnt('anon', null, 'select * from public.payment_invoices') <= 0
  and t.cnt('anon', null, 'select * from public.payment_invoice_items') <= 0 and t.cnt('anon', null, 'select * from public.payment_attempts') <= 0);
select t.chk('L10 superadmin intacto: ve los 8 comprobantes, 8 items, 8 intentos',
  t.cnt('authenticated', :'SU', 'select * from public.payment_invoices') = 8
  and t.cnt('authenticated', :'SU', 'select * from public.payment_invoice_items') = 8
  and t.cnt('authenticated', :'SU', 'select * from public.payment_attempts') = 8);
select t.chk('L11 service_role (Edge Functions) sigue viendo todo', t.cnt('service_role', null, 'select * from public.payment_invoices') = 8);

-- ------------------------------------------------------------ sin escritura aun bloqueado
select t.chk('E1 el bloqueado por mora NO puede actualizar sus comprobantes (0 filas / error)',
  t.wr('authenticated', :'UA', format('update public.payment_invoices set status = ''PAID'' where payer_tenant_id = %L', t.id('A'))) <= 0
  and (select count(*) from public.payment_invoices where payer_tenant_id = t.id('A') and status = 'PAID') = 1);
select t.chk('E2 ... ni borrarlos ni insertar uno',
  t.wr('authenticated', :'UA', format('delete from public.payment_invoices where payer_tenant_id = %L', t.id('A'))) <= 0
  and t.wr('authenticated', :'UA', format('insert into public.payment_invoices(payer_tenant_id, provider_key, amount_cents, status, due_date) values (%L, ''wompi'', 1, ''PAID'', current_date)', t.id('A'))) <= 0
  and (select count(*) from public.payment_invoices where payer_tenant_id = t.id('A')) = 2);
select t.chk('E3 ... ni tocar items ni intentos de pago',
  t.wr('authenticated', :'UA', 'update public.payment_invoice_items set description = ''x''') <= 0
  and t.wr('authenticated', :'UA', 'delete from public.payment_invoice_items') <= 0
  and t.wr('authenticated', :'UA', 'update public.payment_attempts set status = ''X''') <= 0
  and t.wr('authenticated', :'UA', 'delete from public.payment_attempts') <= 0
  and t.wr('authenticated', :'UA', format('insert into public.payment_attempts(invoice_id, provider_key, status) select id, ''wompi'', ''APPROVED'' from public.payment_invoices where payer_tenant_id = %L limit 1', t.id('A'))) <= 0
  and (select count(*) from public.payment_attempts a join public.payment_invoices i on i.id = a.invoice_id where i.payer_tenant_id = t.id('A')) = 2
  and (select count(*) from public.payment_invoice_items where description = 'x') = 0);
select t.chk('E4 el bloqueado por mora NO puede reactivarse a si mismo (tenants.status) ni cambiar su motivo',
  t.wr('authenticated', :'UA', format('update public.tenants set status = ''active'' where id = %L', t.id('A'))) <= 0
  and (select status = 'inactive' and suspension_reason = 'nonpayment' from public.tenants where id = t.id('A')));
create function t.pay_a() returns void language plpgsql as $$
declare r record;
begin
  select * into r from t.as_user('authenticated', '00000000-0000-0000-0000-0000000000a1',
    format('select public.record_manual_payment(%L, null, ''transferencia'', ''ref'', ''x'')', (select id from public.payment_invoices where payer_tenant_id = t.id('A') and status = 'PENDING' limit 1)));
  if not r.ok then raise exception 'pago manual fallo: %', r.msg; end if;
end $$;
-- el pago legitimo sigue reactivando (la politica nueva no interfiere con el trigger)
select t.pay_a();
select t.chk('P1 al pagar (superadmin registra pago manual) el comprobante pendiente, A se reactiva (trigger); el muro deja de aplicar (helper NULL)',
  (select status = 'active' and suspension_reason is null from public.tenants where id = t.id('A'))
  and t.helper('authenticated', :'UA') = 'NULL');
select t.chk('P2 reactivado, A lee sus comprobantes por la policy normal (2, sin duplicados)', t.cnt('authenticated', :'UA', 'select * from public.payment_invoices') = 2);
