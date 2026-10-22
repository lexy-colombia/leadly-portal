-- Comercio (merchant_tenant_id) y kind de cliente. Se ejecuta COMO service_role despues de 16_public_status.sql.
set role service_role;
\set ON_ERROR_STOP 1

create temp table mctx(k text primary key, v jsonb);
grant all on mctx to service_role;

-- ---- kind en clientes ----
insert into mctx select 'EXT', public.payments_admin_create_client('Merch Externo',null,repeat('7',64),'lxy_pay_test_m1111111',null,null);
select t.ok(((select v from mctx where k='EXT')->>'kind') = 'external', 'create_client sin kind (llamada actual de 6 args nombrados) -> external');
insert into mctx select 'INT', public.payments_admin_create_client(
  p_name => 'Merch Interno', p_callback_url => null, p_key_hash => repeat('8',64), p_key_prefix => 'lxy_pay_test_m2222222',
  p_signing_secret_name => null, p_created_by => null, p_kind => 'internal');
select t.ok(((select v from mctx where k='INT')->>'kind') = 'internal', 'create_client con p_kind=internal');
select t.raises($$select public.payments_admin_create_client('Merch Malo',null,repeat('6',64),'x',null,null,'admin')$$,'PY422','kind invalido -> PY422');
select t.raises($$select public.payments_admin_create_client('Merch Nulo',null,repeat('5',64),'x',null,null,null)$$,'PY422','kind null -> PY422');
select t.ok(public.payments_lookup_client(repeat('7',64))->>'kind' = 'external' and public.payments_lookup_client(repeat('8',64))->>'kind' = 'internal',
  'lookup_client devuelve kind');
select t.ok((select count(*) from pg_proc where proname='payments_admin_create_client' and pronamespace='public'::regnamespace) = 1,
  'firma vieja de create_client eliminada (una sola sobrecarga)');
select t.ok((select count(*) from pg_proc where proname='payments_begin_link' and pronamespace='public'::regnamespace) = 1
  and to_regprocedure('public.payments_begin_link(uuid,text,text,jsonb,text,uuid)') is null
  and to_regprocedure('public.payments_begin_link(uuid,text,text,jsonb,text,uuid,uuid)') is not null,
  'firma vieja de begin_link (6 args) eliminada; existe la de 7');

-- ---- begin_link: llamada antigua con los 6 argumentos nombrados sigue resolviendo (default null) ----
insert into mctx select 'OLD', public.payments_begin_link(
  p_client_id => (select (v->>'id')::uuid from mctx where k='EXT'), p_idempotency_key => 'm-old', p_request_hash => 'h-old',
  p_request => jsonb_build_object('amount_in_cents',5000000,'currency','COP','name','n','description','d','external_reference','M-OLD'),
  p_environment => 'sandbox', p_created_by => null);
select t.ok(((select v from mctx where k='OLD')->'link'->>'merchant_tenant_id') is null, '6 args nombrados antiguos resuelven; merchant_tenant_id null');
select t.ok(((select v from mctx where k='OLD')->>'replayed') = 'false', '6 args nombrados: link creado');

-- ---- cliente externo no puede fijar comercio ----
select t.raises($$select public.payments_begin_link((select (v->>'id')::uuid from mctx where k='EXT'),'m-ext','h',
  jsonb_build_object('amount_in_cents',5000000,'currency','COP','name','n','description','d','external_reference','M-EXT'),
  'sandbox',null,'11111111-1111-1111-1111-111111111111')$$,'PY424','externo con comercio -> PY424 (errcode propio)');
select t.ok(not exists (select 1 from payments.payment_links where idempotency_key='m-ext'), 'el rechazo no deja fila');

-- ---- cliente interno: con comercio y sin comercio ----
insert into mctx select 'M1', public.payments_begin_link(
  (select (v->>'id')::uuid from mctx where k='INT'),'m-int','h-m1',
  jsonb_build_object('amount_in_cents',5000000,'currency','COP','name','n','description','d','external_reference','M-INT'),
  'sandbox',null,'11111111-1111-1111-1111-111111111111');
select t.ok(((select v from mctx where k='M1')->'link'->>'merchant_tenant_id') = '11111111-1111-1111-1111-111111111111', 'interno fija merchant_tenant_id');
select t.ok(((select v from mctx where k='M1')->>'replayed') = 'false', 'interno: link creado');

-- replay con mismo hash y mismo comercio
select t.ok((public.payments_begin_link((select (v->>'id')::uuid from mctx where k='INT'),'m-int','h-m1',
  jsonb_build_object('amount_in_cents',5000000,'currency','COP','name','n','description','d','external_reference','M-INT'),
  'sandbox',null,'11111111-1111-1111-1111-111111111111')->>'replayed') = 'true', 'replay mismo hash y comercio -> replayed');
-- misma clave, mismo hash, OTRO comercio (o ninguno) -> conflicto (defensa aunque el hash no incluyera el comercio)
select t.raises($$select public.payments_begin_link((select (v->>'id')::uuid from mctx where k='INT'),'m-int','h-m1',
  jsonb_build_object('amount_in_cents',5000000,'currency','COP','name','n','description','d','external_reference','M-INT'),
  'sandbox',null,'22222222-2222-2222-2222-222222222222')$$,'PY409','misma clave/hash con otro comercio -> PY409');
select t.raises($$select public.payments_begin_link((select (v->>'id')::uuid from mctx where k='INT'),'m-int','h-m1',
  jsonb_build_object('amount_in_cents',5000000,'currency','COP','name','n','description','d','external_reference','M-INT'),
  'sandbox',null)$$,'PY409','misma clave/hash sin comercio (plataforma) -> PY409');
-- interno sin comercio = cuenta de plataforma
select t.ok((public.payments_begin_link((select (v->>'id')::uuid from mctx where k='INT'),'m-plat','h-p',
  jsonb_build_object('amount_in_cents',5000000,'currency','COP','name','n','description','d','external_reference','M-PLAT'),
  'sandbox',null)->'link'->>'merchant_tenant_id') is null, 'interno sin comercio -> plataforma (null)');

-- ---- find_link_by_wompi_id devuelve merchant_tenant_id ----
select public.payments_attach_wompi_link((select (v->'link'->>'id')::uuid from mctx where k='M1'),'wl-merch-1','https://checkout.example/x');
select t.ok(public.payments_find_link_by_wompi_id('wl-merch-1')->>'merchant_tenant_id' = '11111111-1111-1111-1111-111111111111',
  'find_link_by_wompi_id devuelve merchant_tenant_id');
select public.payments_attach_wompi_link((select (v->'link'->>'id')::uuid from mctx where k='OLD'),'wl-merch-0','https://checkout.example/y');
select t.ok(public.payments_find_link_by_wompi_id('wl-merch-0') ? 'merchant_tenant_id' and public.payments_find_link_by_wompi_id('wl-merch-0')->'merchant_tenant_id' = 'null'::jsonb,
  'find_link_by_wompi_id: comercio plataforma -> clave presente con null');

reset role;
-- ---- privilegios ----
select t.ok(not has_function_privilege('anon','public.payments_begin_link(uuid,text,text,jsonb,text,uuid,uuid)','execute')
        and not has_function_privilege('authenticated','public.payments_begin_link(uuid,text,text,jsonb,text,uuid,uuid)','execute')
        and has_function_privilege('service_role','public.payments_begin_link(uuid,text,text,jsonb,text,uuid,uuid)','execute'),
  'begin_link (7 args): solo service_role');
select t.ok(not has_function_privilege('anon','public.payments_admin_create_client(text,text,text,text,text,uuid,text)','execute')
        and has_function_privilege('service_role','public.payments_admin_create_client(text,text,text,text,text,uuid,text)','execute'),
  'create_client (7 args): solo service_role');
select t.ok((select prosecdef from pg_proc where oid='public.payments_begin_link(uuid,text,text,jsonb,text,uuid,uuid)'::regprocedure) is false
        and (select proconfig from pg_proc where oid='public.payments_begin_link(uuid,text,text,jsonb,text,uuid,uuid)'::regprocedure) = array['search_path=""'],
  'begin_link conserva search_path vacio');
