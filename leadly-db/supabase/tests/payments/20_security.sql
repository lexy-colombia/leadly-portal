-- Privilegios, RLS, solo-insertar y aislamiento respecto de public.
create or replace function t.ok(c boolean, name text) returns void language plpgsql as $$
begin if c is not true then raise exception 'FAIL: %', name; end if; raise notice 'PASS: %', name; end $$;
create or replace function t.denied(q text, name text, role text) returns void language plpgsql as $$
declare s text;
begin
  execute format('set local role %I', role);
  begin execute q;
  exception when others then
    get stacked diagnostics s = returned_sqlstate;
    reset role;
    if s = '42501' then raise notice 'PASS: % (permission denied, %)', name, role; return; end if;
    raise exception 'FAIL: % -- SQLSTATE % (%)', name, s, sqlerrm;
  end;
  reset role;
  raise exception 'FAIL: % -- fue permitido a %', name, role;
end $$;
create or replace function t.raises(q text, state text, name text) returns void language plpgsql as $$
declare s text;
begin
  begin execute q;
  exception when others then
    get stacked diagnostics s = returned_sqlstate;
    if s = state then raise notice 'PASS: % (SQLSTATE %)', name, s; return; end if;
    raise exception 'FAIL: % -- esperaba %, obtuvo % (%)', name, state, s, sqlerrm;
  end;
  raise exception 'FAIL: % -- no lanzo', name;
end $$;

-- anon / authenticated: nada
select t.denied('select * from payments.clients', 'anon no lee payments.clients', 'anon');
select t.denied('select * from payments.events', 'authenticated no lee payments.events', 'authenticated');
select t.denied('insert into payments.clients(name,api_key_hash,key_prefix) values (''x'',repeat(''f'',64),''p'')', 'anon no inserta', 'anon');
select t.denied($$select public.payments_lookup_client('x')$$, 'anon no ejecuta payments_lookup_client', 'anon');
select t.denied($$select public.payments_record_event('{}','test',true)$$, 'authenticated no ejecuta payments_record_event', 'authenticated');
select t.denied($$select public.payments_admin_list_clients()$$, 'authenticated no ejecuta payments_admin_list_clients', 'authenticated');
select t.denied($$select public.payments_read_secret('payments/x')$$, 'authenticated no ejecuta payments_read_secret', 'authenticated');

-- matriz completa de EXECUTE
select t.ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'payments\_%'
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute'))),
  'ninguna funcion payments_* ejecutable por public/anon/authenticated');
select t.ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'payments\_%' and not has_function_privilege('service_role', p.oid, 'execute')),
  'todas las funciones payments_* ejecutables por service_role');
select t.ok((select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'payments\_%') = 23,
  'inventario: 23 funciones payments_* (24 previas - record_legacy_event - transaction_usage + payments_internal_client_ok de ST3)');
select t.ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'payments\_%' and p.proconfig is null),
  'toda funcion payments_* tiene search_path fijado');
select t.ok(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'payments\_%' and not ('search_path=""' = any(p.proconfig))),
  'search_path es exactamente ''''');
-- definer solo donde corresponde
select t.ok((select array_agg(proname::text order by proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'payments\_%' and p.prosecdef)
   = array['payments_internal_client_ok','payments_read_secret','payments_store_secret','payments_trigger_dispatch'],
  'security definer solo en internal_client_ok (ST3), read_secret, store_secret y trigger_dispatch');

-- tablas: sin acceso para anon/authenticated/public; RLS on sin policies
select t.ok(not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='payments' and c.relkind='r'
     and (has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger')
          or has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate,references,trigger')
          or has_table_privilege('public', c.oid, 'select,insert,update,delete'))),
  'anon/authenticated/public sin privilegios en tablas de payments');
select t.ok(not has_schema_privilege('anon','payments','usage') and not has_schema_privilege('authenticated','payments','usage'),'sin USAGE en el esquema payments');
select t.ok((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='payments' and c.relkind='r'),'RLS activada en las 6 tablas');
select t.ok((select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='payments' and c.relkind='r')=6,'6 tablas');
select t.ok((select count(*) from pg_policies where schemaname='payments')=0,'0 policies');
select t.ok(not has_table_privilege('service_role','payments.events','delete') and not has_table_privilege('service_role','payments.events','update')
            and has_column_privilege('service_role','payments.events','raw','update') and not has_column_privilege('service_role','payments.events','amount_in_cents','update'),
  'service_role: events solo select/insert + update(raw, raw_redacted_at)');
select t.ok(not has_table_privilege('service_role','payments.payment_links','delete') and not has_table_privilege('service_role','payments.clients','delete'),'service_role sin DELETE en payment_links/clients');

-- service_role no puede mutar tablas solo-insertar (permiso) y ni siquiera el
-- superusuario (trigger)
select t.denied('delete from payments.events', 'service_role no borra events', 'service_role');
select t.denied('update payments.events set amount_in_cents = 1', 'service_role no actualiza columnas resumen de events', 'service_role');
select t.denied('update payments.link_status_history set cause = ''x''', 'service_role no actualiza link_status_history', 'service_role');
select t.denied('delete from payments.delivery_attempts', 'service_role no borra delivery_attempts', 'service_role');
select t.denied('truncate payments.events cascade', 'service_role no trunca events', 'service_role');
select t.raises('update payments.events set tx_status = ''X''', 'PY423', 'trigger: UPDATE sobre events falla incluso para superusuario');
select t.raises('delete from payments.events', 'PY423', 'trigger: DELETE sobre events falla');
select t.raises('update payments.link_status_history set cause = ''x''', 'PY423', 'trigger: UPDATE sobre link_status_history falla');
select t.raises('delete from payments.link_status_history', 'PY423', 'trigger: DELETE sobre link_status_history falla');
select t.raises('update payments.delivery_attempts set error = ''x''', 'PY423', 'trigger: UPDATE sobre delivery_attempts falla');
select t.raises('delete from payments.delivery_attempts', 'PY423', 'trigger: DELETE sobre delivery_attempts falla');
select t.raises('truncate payments.events cascade', 'PY423', 'trigger: TRUNCATE ... CASCADE sobre events falla');
select t.raises('truncate payments.link_status_history', 'PY423', 'trigger: TRUNCATE link_status_history falla');
select t.raises('truncate payments.delivery_attempts', 'PY423', 'trigger: TRUNCATE delivery_attempts falla');
select t.raises('truncate payments.deliveries cascade', 'PY423', 'trigger: TRUNCATE ... CASCADE sobre deliveries falla');
select t.raises('delete from payments.deliveries', 'PY423', 'trigger: DELETE sobre deliveries falla');
select t.raises('update payments.deliveries set body = ''{}''', 'PY423', 'trigger: deliveries.body inmutable');
select t.raises('update payments.deliveries set url = ''https://evil.example''', 'PY423', 'trigger: deliveries.url inmutable');
select t.raises($$select set_config('payments.allow_redact','on',false); update payments.events set raw='{}', amount_in_cents=1 where raw_redacted_at is null$$, 'PY423',
  'trigger: ni con la marca de redaccion se pueden cambiar otras columnas');

-- aislamiento respecto de public: 0 FK / vistas / triggers / dependencias
select t.ok((select count(*) from pg_constraint c
   join pg_class a on a.oid=c.conrelid join pg_namespace an on an.oid=a.relnamespace
   join pg_class b on b.oid=c.confrelid join pg_namespace bn on bn.oid=b.relnamespace
  where c.contype='f' and ((an.nspname='payments' and bn.nspname<>'payments') or (bn.nspname='payments' and an.nspname<>'payments')))=0,
  '0 FK entre payments y otros esquemas');
select t.ok((select count(*) from pg_constraint c join pg_class a on a.oid=c.conrelid join pg_namespace an on an.oid=a.relnamespace where an.nspname='payments' and c.contype='f')=8,'8 FK en payments, todas internas');
select t.ok((select count(*) from pg_views where schemaname='payments' or definition ilike '%payments.%')=0,'0 vistas en payments ni vistas que lean payments');
select t.ok((select count(*) from pg_matviews where schemaname='payments')=0,'0 vistas materializadas');
select t.ok((select count(*) from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace
   where not tg.tgisinternal and n.nspname='public' and tg.tgfoid in (select p.oid from pg_proc p join pg_namespace pn on pn.oid=p.pronamespace where pn.nspname='payments'))=0,
  '0 triggers en tablas de public que invoquen funciones de payments');
select t.ok((select count(*) from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_namespace n on n.oid=c.relnamespace
   join pg_proc p on p.oid=tg.tgfoid join pg_namespace pn on pn.oid=p.pronamespace
   where not tg.tgisinternal and n.nspname='payments' and pn.nspname<>'payments')=0,
  '0 triggers de payments que invoquen funciones fuera de payments');
select t.ok((select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='payments' and p.prosrc ~* '(public\.[a-z_]+|from\s+profiles|tenants)')=0,
  'ninguna funcion de payments referencia objetos de public');
select t.ok((select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'payments\_%' and p.prosrc ~* '(public\.(tenants|profiles|clients|sales_orders|products|[a-z_]*orders)\b|\mtenants\M|\mprofiles\M)')=0,
  'wrappers payments_* no leen tablas de negocio de public');
select t.ok((select count(*) from pg_depend d join pg_class c on c.oid=d.objid join pg_namespace n on n.oid=c.relnamespace
   join pg_class r on r.oid=d.refobjid join pg_namespace rn on rn.oid=r.relnamespace
   where n.nspname='payments' and rn.nspname='public' and d.deptype in ('n','a'))=0,'0 dependencias de objetos payments hacia relaciones de public');
