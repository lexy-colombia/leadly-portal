-- D4/D5/D6: bloqueo por mora con motivo, reactivacion al pagar, bloqueo manual, guard y privilegios.
set client_min_messages = warning;
select t.setclock('2026-10-20 08:00:00-05');
select t.tenant(k) from unnest(array['A','G1','G2','C5','P2','MAN','MAN2','A8','CAN','F9','GRD','TT']) k;
insert into public.profiles(id, tenant_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', null, 'superadmin'),
  ('00000000-0000-0000-0000-0000000000b1', t.id('GRD'), 'tenant_admin');
\set SU '00000000-0000-0000-0000-0000000000a1'
\set TA '00000000-0000-0000-0000-0000000000b1'
create function t.st(p_k text) returns text language sql stable as $$ select status || '/' || coalesce(suspension_reason, '-') from public.tenants where id = t.id(p_k) $$;
create function t.pay(p_inv uuid) returns void language plpgsql as $$
declare r record;
begin
  select * into r from t.as_user('authenticated', '00000000-0000-0000-0000-0000000000a1',
    format('select public.record_manual_payment(%L, null, ''transferencia'', ''ref'', ''test'')', p_inv));
  if not r.ok then raise exception 'pago manual fallo: %', r.msg; end if;
end $$;

-- ------------------------------------------------------------ mora -> bloqueo con motivo, SIN error
select t.mk_inv(t.id('A'), date '2026-10-10');
select t.chk('M0 estado inicial: tenant A activo', t.st('A') = 'active/-');
select t.run_as('M1 el cron de mora (sin claims, como pg_cron) NO falla', null, null, 'select public.deactivate_tenants_with_overdue_invoices()', true);
select t.chk('M2 A queda inactive con suspension_reason=nonpayment y suspended_at = ahora',
  t.st('A') = 'inactive/nonpayment' and (select suspended_at = '2026-10-20 08:00:00-05' from public.tenants where id = t.id('A')));
select t.chk('M3 el comprobante vencido quedo OVERDUE (mark_overdue_invoices en la misma corrida)',
  (select status from public.payment_invoices where payer_tenant_id = t.id('A')) = 'OVERDUE');
select public.deactivate_tenants_with_overdue_invoices();
select t.chk('M4 idempotente: una 2a corrida no cambia suspended_at',
  (select suspended_at = '2026-10-20 08:00:00-05' from public.tenants where id = t.id('A')));

-- gracia de 3 dias: due 10-17 (hace 3 dias) NO; due 10-16 SI
select t.mk_inv(t.id('G1'), date '2026-10-17'); select t.mk_inv(t.id('G2'), date '2026-10-16');
select public.deactivate_tenants_with_overdue_invoices();
select t.chk('G1 vencido hace exactamente 3 dias: AUN activo (gracia); hace 4 dias: bloqueado',
  t.st('G1') = 'active/-' and t.st('G2') = 'inactive/nonpayment');
select t.setclock('2026-10-21 08:00:00-05'); select public.deactivate_tenants_with_overdue_invoices();
select t.chk('G2 un dia despues (vencido hace 4 dias) G1 queda bloqueado', t.st('G1') = 'inactive/nonpayment');
select t.setclock('2026-10-20 08:00:00-05');

-- ------------------------------------------------------------ reactivacion
select t.pay(id) from public.payment_invoices where payer_tenant_id = t.id('A');
select t.chk('R1 pagar el comprobante (record_manual_payment) reactiva al instante por TRIGGER: active, motivo y fecha limpios',
  t.st('A') = 'active/-' and (select suspended_at is null from public.tenants where id = t.id('A')));

-- por cron (trigger desactivado): el pago NO reactiva, la corrida horaria SI
select t.mk_inv(t.id('C5'), date '2026-10-01');
select public.deactivate_tenants_with_overdue_invoices();
alter table public.payment_invoices disable trigger payment_invoices_reactivate_tenant;
select t.pay(id) from public.payment_invoices where payer_tenant_id = t.id('C5');
select t.chk('R2a sin el trigger el pago no reactiva (control de la prueba)', t.st('C5') = 'inactive/nonpayment');
select public.deactivate_tenants_with_overdue_invoices();
select t.chk('R2b el cron horario reactiva al tenant bloqueado por mora que ya pago', t.st('C5') = 'active/-');
alter table public.payment_invoices enable trigger payment_invoices_reactivate_tenant;

-- dos comprobantes vencidos: pagar uno no reactiva, pagar los dos si
select t.mk_inv(t.id('P2'), date '2026-09-10'); select t.mk_inv(t.id('P2'), date '2026-10-01');
select public.deactivate_tenants_with_overdue_invoices();
select t.pay(id) from (select id from public.payment_invoices where payer_tenant_id = t.id('P2') order by due_date limit 1) z;
select t.chk('R3a con otro comprobante vencido sin pagar el tenant sigue bloqueado', t.st('P2') = 'inactive/nonpayment');
select t.pay(id) from public.payment_invoices where payer_tenant_id = t.id('P2') and status in ('PENDING', 'OVERDUE');
select t.chk('R3b al pagar el ultimo vencido se reactiva', t.st('P2') = 'active/-');

-- comprobante CANCELLED no bloquea: el cron reactiva
select t.mk_inv(t.id('CAN'), date '2026-10-01');
select public.deactivate_tenants_with_overdue_invoices();
update public.payment_invoices set status = 'CANCELLED' where payer_tenant_id = t.id('CAN');
select public.deactivate_tenants_with_overdue_invoices();
select t.chk('R4 comprobante CANCELLED por el superadmin: el cron reactiva al bloqueado por mora', t.st('CAN') = 'active/-');

-- ------------------------------------------------------------ bloqueo MANUAL
select t.run_as('X0 el superadmin bloquea a MAN manualmente', 'authenticated', :'SU'::uuid,
  format('update public.tenants set status = ''inactive'' where id = %L', t.id('MAN')), true);
select t.chk('X1 bloqueo manual: motivo NULL', t.st('MAN') = 'inactive/-');
select public.deactivate_tenants_with_overdue_invoices();
select t.chk('X2 el cron NO reactiva un bloqueo manual (sin deudas)', t.st('MAN') = 'inactive/-');
select t.pay(t.mk_inv(t.id('MAN'), date '2026-12-01'));
select t.chk('X3 pagar un comprobante tampoco reactiva un bloqueo manual', t.st('MAN') = 'inactive/-');
-- manual + deuda vencida: el cron no le pone motivo (ya estaba inactivo) y el pago no lo reactiva
select t.run_as('X4 bloqueo manual de MAN2', 'authenticated', :'SU'::uuid, format('update public.tenants set status = ''inactive'' where id = %L', t.id('MAN2')), true);
select t.mk_inv(t.id('MAN2'), date '2026-09-01');
select public.deactivate_tenants_with_overdue_invoices();
select t.chk('X5 manual + deuda: el cron no le asigna motivo (sigue inactive/-)', t.st('MAN2') = 'inactive/-');
select t.pay(id) from public.payment_invoices where payer_tenant_id = t.id('MAN2') and status in ('PENDING', 'OVERDUE');
select public.deactivate_tenants_with_overdue_invoices();
select t.chk('X6 manual + deuda pagada + cron: sigue bloqueado (un humano lo reactiva)', t.st('MAN2') = 'inactive/-');
-- reactivacion manual limpia el motivo
select t.mk_inv(t.id('A8'), date '2026-10-01');
select public.deactivate_tenants_with_overdue_invoices();
select t.chk('X7a A8 bloqueado por mora', t.st('A8') = 'inactive/nonpayment');
select t.run_as('X7b el superadmin lo reactiva a mano (sin pagar)', 'authenticated', :'SU'::uuid, format('update public.tenants set status = ''active'' where id = %L', t.id('A8')), true);
select t.chk('X7c la reactivacion manual limpia motivo y fecha (trigger BEFORE UPDATE OF status)',
  t.st('A8') = 'active/-' and (select suspended_at is null from public.tenants where id = t.id('A8')));
select public.deactivate_tenants_with_overdue_invoices();
select t.chk('X7d (comportamiento) sin pagar, el cron lo vuelve a bloquear en la siguiente corrida', t.st('A8') = 'inactive/nonpayment');
-- constraint
select t.run_as('X8 CHECK: un tenant ACTIVO no puede tener motivo', null, null,
  format('update public.tenants set suspension_reason = ''nonpayment'' where id = %L', t.id('TT')), false, '%tenants_suspension_requires_inactive_check%');
select t.run_as('X9 CHECK: motivo fuera del catalogo rechazado', null, null,
  format('update public.tenants set status = ''inactive'', suspension_reason = ''otro'' where id = %L', t.id('TT')), false, '%tenants_suspension_reason_check%');

-- ------------------------------------------------------------ el pago NO se revierte si la reactivacion falla
select t.mk_inv(t.id('F9'), date '2026-10-01');
select public.deactivate_tenants_with_overdue_invoices();
do $$
declare v_def text; v_inv uuid;
begin
  v_def := pg_get_functiondef('public.reactivate_tenant_if_paid(uuid)'::regprocedure);
  create or replace function public.reactivate_tenant_if_paid(p_tenant_id uuid) returns boolean language plpgsql as
    $f$ begin raise exception 'fallo simulado de la reactivacion'; end $f$;
  select id into v_inv from public.payment_invoices where payer_tenant_id = t.id('F9');
  perform t.pay(v_inv);
  perform t.chk('R5 si la reactivacion falla, el PAGO se conserva (PAID) y solo se avisa con WARNING; el tenant sigue bloqueado hasta el cron',
    (select status from public.payment_invoices where id = v_inv) = 'PAID' and t.st('F9') = 'inactive/nonpayment');
  execute v_def;
  perform public.deactivate_tenants_with_overdue_invoices();
  perform t.chk('R5b restaurada la funcion, el cron horario lo reactiva', t.st('F9') = 'active/-');
end $$;

-- ------------------------------------------------------------ GUARD de escalada (D5)
select t.run_as('GU1 superadmin (authenticated) cambia status', 'authenticated', :'SU'::uuid, format('update public.tenants set status = ''inactive'' where id = %L', t.id('GRD')), true);
select t.run_as('GU1b superadmin reactiva', 'authenticated', :'SU'::uuid, format('update public.tenants set status = ''active'' where id = %L', t.id('GRD')), true);
select t.run_as('GU2 service_role (Edge Function de confianza) cambia status', 'service_role', null, format('update public.tenants set status = ''inactive'' where id = %L', t.id('GRD')), true);
select t.run_as('GU3 pg_cron / SQL directo (sin claims) cambia status', null, null, format('update public.tenants set status = ''active'' where id = %L', t.id('GRD')), true);
select t.run_as('GU4 tenant_admin (authenticated) NO cambia su status', 'authenticated', :'TA'::uuid, format('update public.tenants set status = ''inactive'' where id = %L', t.id('GRD')), false, 'Not authorized%');
select t.chk('GU4b ... y su tenant sigue active', t.st('GRD') = 'active/-');
select t.run_as('GU5 anon NO cambia status', 'anon', null, format('update public.tenants set status = ''inactive'' where id = %L', t.id('GRD')), false, 'Not authorized%');
select t.run_as('GU6 tenant_admin NO puede escribirse suspension_reason (evita saltarse un bloqueo manual)', 'authenticated', :'TA'::uuid,
  format('update public.tenants set suspension_reason = ''nonpayment'' where id = %L', t.id('GRD')), false, 'Not authorized%');
select t.run_as('GU7 tenant_admin NO puede escribirse suspended_at', 'authenticated', :'TA'::uuid,
  format('update public.tenants set suspended_at = now() where id = %L', t.id('GRD')), false, 'Not authorized%');
select t.run_as('GU8 tenant_admin SI puede editar columnas normales (name)', 'authenticated', :'TA'::uuid,
  format('update public.tenants set name = ''zz GRD renombrado'' where id = %L', t.id('GRD')), true);
select t.run_as('GU9 usuario authenticated desconocido (sin profile) NO cambia status', 'authenticated', '00000000-0000-0000-0000-0000000000ff'::uuid,
  format('update public.tenants set status = ''inactive'' where id = %L', t.id('GRD')), false, 'Not authorized%');
-- escalada: un tenant_admin de un tenant bloqueado a mano no puede reactivarse ni "etiquetarse" mora
select t.run_as('GU10 tenant_admin de un tenant inactivo NO puede reactivarse', null, null, format('update public.tenants set status = ''inactive'' where id = %L', t.id('GRD')), true);
select t.run_as('GU10b ... intento de reactivarse', 'authenticated', :'TA'::uuid, format('update public.tenants set status = ''active'' where id = %L', t.id('GRD')), false, 'Not authorized%');
select t.run_as('GU10c ... intento de ponerse suspension_reason=nonpayment (para que el cron lo reactive)', 'authenticated', :'TA'::uuid,
  format('update public.tenants set suspension_reason = ''nonpayment'' where id = %L', t.id('GRD')), false, 'Not authorized%');
select t.run_as('GU10d restaurar GRD', null, null, format('update public.tenants set status = ''active'' where id = %L', t.id('GRD')), true);

-- REGRESION con el guard VIEJO + migraciones nuevas: el cron vuelve a fallar
do $$
declare v_new text; r record;
begin
  v_new := pg_get_functiondef('public.prevent_tenant_self_service_escalation()'::regprocedure);
  create or replace function public.prevent_tenant_self_service_escalation() returns trigger language plpgsql security definer set search_path = public as
  $f$ begin
    if public.is_superadmin() then return new; end if;
    if new.status is distinct from old.status or new.id is distinct from old.id or new.created_at is distinct from old.created_at then
      raise exception 'Not authorized to change status/id/created_at on this tenant';
    end if;
    return new; end $f$;
  perform t.mk_inv(t.id('TT'), date '2026-09-01');
  select * into r from t.as_user(null, null, 'select public.deactivate_tenants_with_overdue_invoices()');
  perform t.chk('GU11 REGRESION: con el guard VIEJO el cron de mora falla (el caso que el arreglo corrige)', not r.ok and r.msg like 'Not authorized%', coalesce(r.msg, 'sin error'));
  perform t.chk('GU11b ... y revierte tambien mark_overdue_invoices', (select status from public.payment_invoices where payer_tenant_id = t.id('TT')) = 'PENDING');
  execute v_new;
  select * into r from t.as_user(null, null, 'select public.deactivate_tenants_with_overdue_invoices()');
  perform t.chk('GU12 con el guard NUEVO restaurado el mismo cron funciona y bloquea a TT', r.ok and t.st('TT') = 'inactive/nonpayment', coalesce(r.msg, 'ok'));
end $$;

-- ------------------------------------------------------------ privilegios
do $$
declare f text; r text;
begin
  foreach f in array array['process_recurring_billing_invoices()', 'deactivate_tenants_with_overdue_invoices()', 'mark_overdue_invoices()',
                           'tenant_has_blocking_invoice(uuid)', 'reactivate_tenant_if_paid(uuid)'] loop
    foreach r in array array['anon', 'authenticated', 'public'] loop
      perform t.chk(format('P1 %s NO puede ejecutar %s', r, f), not has_function_privilege(r, 'public.' || f, 'execute'));
    end loop;
    perform t.chk(format('P2 service_role SI puede ejecutar %s', f), has_function_privilege('service_role', 'public.' || f, 'execute'));
  end loop;
  perform t.chk('P3 trigger de reactivacion al pagar: sin EXECUTE para anon/authenticated/public',
    not has_function_privilege('anon', 'public.payment_invoices_reactivate_tenant_on_paid()', 'execute')
    and not has_function_privilege('authenticated', 'public.payment_invoices_reactivate_tenant_on_paid()', 'execute')
    and not has_function_privilege('public', 'public.payment_invoices_reactivate_tenant_on_paid()', 'execute'));
  perform t.chk('P4 create_invoice_for_subscription(uuid,date): authenticated y service_role si, anon no',
    has_function_privilege('authenticated', 'public.create_invoice_for_subscription(uuid,date)', 'execute')
    and has_function_privilege('service_role', 'public.create_invoice_for_subscription(uuid,date)', 'execute')
    and not has_function_privilege('anon', 'public.create_invoice_for_subscription(uuid,date)', 'execute')
    and not has_function_privilege('public', 'public.create_invoice_for_subscription(uuid,date)', 'execute'));
  perform t.chk('P5 todas las funciones nuevas son SECURITY DEFINER con search_path fijo (salvo el trigger BEFORE de limpieza, invoker)',
    (select bool_and(p.prosecdef and p.proconfig::text like '%search_path=public%') from pg_proc p
     where p.proname in ('tenant_has_blocking_invoice', 'reactivate_tenant_if_paid', 'payment_invoices_reactivate_tenant_on_paid',
                         'deactivate_tenants_with_overdue_invoices', 'process_recurring_billing_invoices', 'create_invoice_for_subscription',
                         'prevent_tenant_self_service_escalation')));
end $$;
select t.run_as('P6 llamada real: anon NO puede correr el cron de mora', 'anon', null, 'select public.deactivate_tenants_with_overdue_invoices()', false, '%permission denied%');
select t.run_as('P7 llamada real: authenticated NO puede reactivar tenants', 'authenticated', :'TA'::uuid,
  format('select public.reactivate_tenant_if_paid(%L)', t.id('TT')), false, '%permission denied%');
select t.run_as('P8 llamada real: authenticated NO puede correr process_recurring_billing_invoices', 'authenticated', :'SU'::uuid,
  'select public.process_recurring_billing_invoices()', false, '%permission denied%');
