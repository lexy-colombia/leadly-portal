-- Pruebas funcionales de las reglas de negocio. Se ejecuta COMO service_role
-- (el mismo rol que usara la Edge Function), no como superusuario.
create schema if not exists t;
create or replace function t.ok(c boolean, name text) returns void language plpgsql as $$
begin
  if c is not true then raise exception 'FAIL: %', name; end if;
  raise notice 'PASS: %', name;
end $$;
create or replace function t.raises(q text, state text, name text) returns void language plpgsql as $$
declare s text;
begin
  begin
    execute q;
  exception when others then
    get stacked diagnostics s = returned_sqlstate;
    if s = state then raise notice 'PASS: % (SQLSTATE %)', name, s; return; end if;
    raise exception 'FAIL: % -- esperaba %, obtuvo % (%)', name, state, s, sqlerrm;
  end;
  raise exception 'FAIL: % -- no lanzo excepcion', name;
end $$;
-- evento Wompi sintetico
create or replace function t.ev(link text, tx text, st text, amt bigint default 5000000, cur text default 'COP',
                                env text default 'test', extra jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object('event','transaction.updated',
    'data', jsonb_build_object('transaction', jsonb_build_object('id',tx,'status',st,'amount_in_cents',amt,
        'currency',cur,'payment_link_id',link,'reference','auto-ref') || extra),
    'environment', env, 'sent_at','2026-10-10T12:00:00.000Z','timestamp',1760097600,
    'signature', jsonb_build_object('properties', '["transaction.id"]'::jsonb, 'checksum','X'))
$$;
-- Replica lo que hara P2: verifica contra Wompi y pasa p_verified derivado del payload.
create or replace function t.verified(p jsonb) returns jsonb language sql immutable as $$
  select case when p #> '{data,transaction}' is null or jsonb_typeof(p #> '{data,transaction}') <> 'object' then null
    else jsonb_build_object('id', p #>> '{data,transaction,id}', 'status', p #>> '{data,transaction,status}',
         'amount_in_cents', p #> '{data,transaction,amount_in_cents}', 'currency', p #>> '{data,transaction,currency}',
         'payment_link_id', p #>> '{data,transaction,payment_link_id}', 'reference', 'auto-ref') end
$$;
create or replace function t.rec(p jsonb, env text, sig boolean) returns jsonb language sql as $$
  select public.payments_record_event(p, env, sig, t.verified(p))
$$;
create or replace function t.mklink(cid uuid, key text, ref text, wid text, amt bigint default 5000000) returns uuid
language plpgsql as $$
declare l jsonb; i uuid;
begin
  l := public.payments_begin_link(cid, key, 'h-'||key, jsonb_build_object('amount_in_cents',amt,'currency','COP',
        'name','n','description','d','external_reference',ref), 'sandbox', null);
  i := (l->'link'->>'id')::uuid;
  perform public.payments_attach_wompi_link(i, wid, 'u');
  return i;
end $$;
grant usage on schema t to service_role;
grant execute on all functions in schema t to service_role;

set role service_role;
\set ON_ERROR_STOP 1

-- ---- proyectos ----
create temp table ctx(k text primary key, v jsonb);
grant all on ctx to service_role;
insert into ctx select 'A', public.payments_admin_create_client('Proyecto A','https://a.example/hook',
  repeat('a',64),'lxy_pay_test_aaaaaaaa','payments/A/signing',null);
insert into ctx select 'B', public.payments_admin_create_client('Proyecto B',null,repeat('b',64),'lxy_pay_test_bbbbbbbb',null,null);
select t.ok((select v ? 'api_key_hash' from ctx where k='A') is false, 'create_client no expone el hash');
select t.raises($$select public.payments_admin_create_client('Proyecto A',null,repeat('c',64),'x',null,null)$$,'PY409','nombre duplicado -> PY409');
select t.raises($$select public.payments_admin_create_client('X','http://x.example',repeat('d',64),'x',null,null)$$,'PY422','callback http rechazado');
select t.raises($$select public.payments_admin_create_client('X',null,'nohex','x',null,null)$$,'PY422','hash invalido rechazado');
select t.raises($$select public.payments_admin_create_client('X',null,repeat('d',64),'x',null,null);
                  select public.payments_admin_create_client('Y',null,repeat('d',64),'x',null,null)$$,'PY409','hash duplicado -> PY409');

-- lookup
select t.ok((public.payments_lookup_client(repeat('a',64))->>'name') = 'Proyecto A', 'lookup_client activo');
select t.ok(public.payments_lookup_client(repeat('9',64)) is null, 'lookup_client desconocido -> null');
select public.payments_admin_set_client_status((select (v->>'id')::uuid from ctx where k='B'),'suspended');
select t.ok(public.payments_lookup_client(repeat('b',64)) is null, 'lookup_client suspendido -> null');
select t.raises($$select public.payments_admin_set_client_status(gen_random_uuid(),'active')$$,'PY404','set_status inexistente');
select t.raises($$select public.payments_admin_set_client_status((select (v->>'id')::uuid from ctx where k='A'),'revoked')$$,'PY422','status invalido');
select public.payments_admin_set_client_status((select (v->>'id')::uuid from ctx where k='B'),'active');

-- ---- begin_link / idempotencia ----
create or replace function pg_temp.req(extref text, amt bigint default 5000000) returns jsonb language sql as $$
  select jsonb_build_object('amount_in_cents',amt,'currency','COP','name','Pedido','description','Desc',
                            'external_reference',extref,'metadata',jsonb_build_object('k','v'))
$$;
grant execute on function pg_temp.req(text,bigint) to service_role;

insert into ctx select 'L1', public.payments_begin_link((select (v->>'id')::uuid from ctx where k='A'),'idem-1','h1',pg_temp.req('REF-1'),'sandbox',null);
select t.ok((select v->>'replayed' from ctx where k='L1')='false' and (select v->'link'->>'status' from ctx where k='L1')='creating','begin_link crea en creating');
select t.ok((public.payments_begin_link((select (v->>'id')::uuid from ctx where k='A'),'idem-1','h1',pg_temp.req('REF-1'),'sandbox',null)->>'replayed')='true','begin_link replay mismo hash');
select t.ok((public.payments_begin_link((select (v->>'id')::uuid from ctx where k='A'),'idem-1','h1',pg_temp.req('REF-1'),'sandbox',null)->'link'->>'id') = (select v->'link'->>'id' from ctx where k='L1'),'replay devuelve la misma fila');
select t.raises($$select public.payments_begin_link((select (v->>'id')::uuid from ctx where k='A'),'idem-1','OTRO',pg_temp.req('REF-1'),'sandbox',null)$$,'PY409','otro hash misma clave -> PY409');
select t.raises($$select public.payments_begin_link((select (v->>'id')::uuid from ctx where k='A'),'idem-2','h2',pg_temp.req('R',0),'sandbox',null)$$,'PY422','monto 0 rechazado');
select t.raises($$select public.payments_begin_link((select (v->>'id')::uuid from ctx where k='A'),'idem-2','h2',jsonb_set(pg_temp.req('R'),'{currency}','"USD"'),'sandbox',null)$$,'PY422','moneda != COP rechazada');
select t.raises($$select public.payments_begin_link((select (v->>'id')::uuid from ctx where k='A'),'idem-2','h2',jsonb_set(pg_temp.req('R'),'{redirect_url}','"http://x.example"'),'sandbox',null)$$,'PY422','redirect_url http rechazada');
select t.raises($$select public.payments_begin_link((select (v->>'id')::uuid from ctx where k='A'),'idem-2','h2',pg_temp.req('R'),'staging',null)$$,'PY422','ambiente invalido');
select t.raises($$select public.payments_begin_link((select (v->>'id')::uuid from ctx where k='A'),'bad key!','h2',pg_temp.req('R'),'sandbox',null)$$,'PY422','idempotency key invalida');
select t.raises($$select public.payments_begin_link(gen_random_uuid(),'idem-9','h',pg_temp.req('R'),'sandbox',null)$$,'PY404','proyecto inexistente');

-- misma clave de idempotencia en OTRO proyecto es otra fila (aislamiento)
insert into ctx select 'LB', public.payments_begin_link((select (v->>'id')::uuid from ctx where k='B'),'idem-1','h1',pg_temp.req('REF-1'),'sandbox',null);
select t.ok((select v->'link'->>'id' from ctx where k='LB') <> (select v->'link'->>'id' from ctx where k='L1'),'misma Idempotency-Key en otro proyecto -> otra fila');

-- attach / fail
select public.payments_attach_wompi_link((select (v->'link'->>'id')::uuid from ctx where k='L1'),'wl_1','https://checkout.wompi.co/l/wl_1');
select t.ok((select status from payments.payment_links where wompi_link_id='wl_1')='pending','attach: creating -> pending');
select t.ok((public.payments_attach_wompi_link((select (v->'link'->>'id')::uuid from ctx where k='L1'),'wl_1','https://checkout.wompi.co/l/wl_1')->>'status')='pending','attach idempotente');
select t.raises($$select public.payments_attach_wompi_link((select (v->'link'->>'id')::uuid from ctx where k='L1'),'wl_other','u')$$,'PY423','attach sobre pending con otro id -> PY423');
select t.raises($$select public.payments_fail_link((select (v->'link'->>'id')::uuid from ctx where k='L1'),'x')$$,'PY423','fail sobre pending -> PY423');
insert into ctx select 'L2', public.payments_begin_link((select (v->>'id')::uuid from ctx where k='A'),'idem-l2','h',pg_temp.req('REF-2'),'sandbox',null);
select public.payments_fail_link((select (v->'link'->>'id')::uuid from ctx where k='L2'),'wompi 422');
select t.ok((select status from payments.payment_links where external_reference='REF-2')='error','fail_link: creating -> error');
select t.raises($$select public.payments_attach_wompi_link((select (v->'link'->>'id')::uuid from ctx where k='L1'),'wl_1b','u'); select public.payments_attach_wompi_link((select (v->'link'->>'id')::uuid from ctx where k='L2'),'wl_2','u')$$,'PY423','attach sobre error -> PY423');

-- links para los casos de eventos
insert into ctx select 'L3', public.payments_begin_link((select (v->>'id')::uuid from ctx where k='A'),'idem-l3','h',pg_temp.req('REF-3'),'sandbox',null);
select public.payments_attach_wompi_link((select (v->'link'->>'id')::uuid from ctx where k='L3'),'wl_3','u');
insert into ctx select 'L4', public.payments_begin_link((select (v->>'id')::uuid from ctx where k='A'),'idem-l4','h',pg_temp.req('REF-4'),'sandbox',null);
select public.payments_attach_wompi_link((select (v->'link'->>'id')::uuid from ctx where k='L4'),'wl_4','u');
select public.payments_attach_wompi_link((select (v->'link'->>'id')::uuid from ctx where k='LB'),'wl_b','u');

-- ---- get_link / aislamiento ----
select t.ok((public.payments_get_link((select (v->>'id')::uuid from ctx where k='A'),(select (v->'link'->>'id')::uuid from ctx where k='L1'),null)->>'external_reference')='REF-1','get_link por id');
select t.ok((public.payments_get_link((select (v->>'id')::uuid from ctx where k='A'),null,'REF-1')->>'id') = (select v->'link'->>'id' from ctx where k='L1'),'get_link por external_reference');
select t.raises($$select public.payments_get_link((select (v->>'id')::uuid from ctx where k='B'),(select (v->'link'->>'id')::uuid from ctx where k='L1'),null)$$,'PY404','proyecto B no ve link de A por id');
select t.ok((public.payments_get_link((select (v->>'id')::uuid from ctx where k='B'),null,'REF-1')->>'id') = (select v->'link'->>'id' from ctx where k='LB'),'external_reference igual en B devuelve el de B, no el de A');
select t.raises($$select public.payments_get_link((select (v->>'id')::uuid from ctx where k='B'),null,'REF-3')$$,'PY404','proyecto B no ve REF-3 de A');
select t.ok(jsonb_array_length(public.payments_list_links((select (v->>'id')::uuid from ctx where k='B'),null,50,null)->'items')=1,'list_links por proyecto solo ve los suyos');
select t.ok(jsonb_array_length(public.payments_list_links(null,null,50,null)->'items')>=5,'list_links admin ve todos');
select t.ok(jsonb_array_length(public.payments_list_links(null,'pending',50,null)->'items') = (select count(*) from payments.payment_links where status='pending'),'list_links filtro status');
-- paginacion
select t.ok((public.payments_list_links(null,null,2,null)->>'next_before') is not null,'list_links next_before cuando hay mas');
select t.ok(jsonb_array_length(public.payments_list_links(null,null,2,(public.payments_list_links(null,null,2,null)->>'next_before')::timestamptz)->'items') >= 0,'list_links before');

-- ---- record_event ----
create temp table r(k text primary key, v jsonb);
grant all on r to service_role;
insert into r select 'e1', t.rec(t.ev('wl_1','T1','PENDING'),'test',true);
select t.ok((select v->>'classification' from r where k='e1')='processed' and (select v->>'link_status' from r where k='e1')='pending','PENDING -> processed, link sigue pending');
select t.ok(jsonb_array_length((select v->'deliveries' from r where k='e1'))=1 and (select v->'deliveries'->0->>'url' from r where k='e1')='https://a.example/hook','PENDING encola 1 entrega con url del proyecto');
insert into r select 'e2', t.rec(t.ev('wl_1','T1','DECLINED'),'test',true);
select t.ok((select v->>'classification' from r where k='e2')='processed' and (select v->>'link_status' from r where k='e2')='pending','DECLINED se propaga sin cerrar');
insert into r select 'e3', t.rec(t.ev('wl_1','T2','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='e3')='processed' and (select v->>'link_status' from r where k='e3')='paid','primera APPROVED -> link paid');
select t.ok((select paid_transaction_id from payments.payment_links where wompi_link_id='wl_1')='T2' and (select paid_at from payments.payment_links where wompi_link_id='wl_1') is not null,'paid_transaction_id y paid_at');
select t.ok((select count(*) from payments.link_status_history h join payments.payment_links l on l.id=h.link_id where l.wompi_link_id='wl_1' and h.to_status='paid' and h.cause='wompi_approved' and h.event_id=(select (v->>'event_id')::bigint from r where k='e3'))=1,'historial registra paid con event_id');
insert into r select 'e4', t.rec(t.ev('wl_1','T2','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='e4')='duplicate' and jsonb_array_length((select v->'deliveries' from r where k='e4'))=0,'repeticion (tx,status,link) -> duplicate sin encolar');
insert into r select 'e5', t.rec(t.ev('wl_1','T3','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='e5')='duplicate_payment' and (select v->>'link_status' from r where k='e5')='paid','segunda APPROVED -> duplicate_payment, link sigue paid');
select t.ok((select paid_transaction_id from payments.payment_links where wompi_link_id='wl_1')='T2','paid_transaction_id no cambia con duplicate_payment');
select t.ok((select body->>'classification' from payments.deliveries where id=((select v->'deliveries'->0->>'id' from r where k='e5')::uuid))='duplicate_payment','aviso de duplicate_payment encolado');
insert into r select 'e6', t.rec(t.ev('wl_1','T2','VOIDED'),'test',true);
select t.ok((select v->>'classification' from r where k='e6')='processed' and (select v->>'link_status' from r where k='e6')='voided','VOIDED de la tx pagada -> processed y link voided');
insert into r select 'e7', t.rec(t.ev('wl_1','T9','ERROR'),'test',true);
select t.ok((select v->>'classification' from r where k='e7')='processed','ERROR se propaga');

-- fuera de orden: APPROVED antes que PENDING de la misma tx
insert into r select 'o1', t.rec(t.ev('wl_3','U1','APPROVED'),'test',true);
insert into r select 'o2', t.rec(t.ev('wl_3','U1','PENDING'),'test',true);
select t.ok((select v->>'link_status' from r where k='o1')='paid' and (select v->>'link_status' from r where k='o2')='paid' and (select v->>'classification' from r where k='o2')='processed','evento fuera de orden (PENDING despues de APPROVED) no degrada el link');

-- monto / moneda distintos
insert into r select 'm1', t.rec(t.ev('wl_4','M1','APPROVED',100),'test',true);
select t.ok((select v->>'classification' from r where k='m1')='amount_mismatch' and (select v->>'link_status' from r where k='m1')='pending','monto distinto -> amount_mismatch, NO marca pagado');
select t.ok((select amount_matches from payments.events where id=(select (v->>'event_id')::bigint from r where k='m1')) is false,'evento mismatch guardado con amount_matches=false');
select t.ok((select body->>'classification' from payments.deliveries where id=((select v->'deliveries'->0->>'id' from r where k='m1')::uuid))='amount_mismatch','aviso amount_mismatch encolado para el proyecto');
insert into r select 'm2', t.rec(t.ev('wl_4','M2','APPROVED',5000000,'USD'),'test',true);
select t.ok((select v->>'classification' from r where k='m2')='amount_mismatch' and (select status from payments.payment_links where wompi_link_id='wl_4')='pending','moneda distinta -> amount_mismatch, sigue pending');
insert into r select 'm3', t.rec(t.ev('wl_4','M1','APPROVED',100),'test',true);
select t.ok((select v->>'classification' from r where k='m3')='duplicate','mismatch repetido -> duplicate (no re-alerta)');
insert into r select 'm4', t.rec(t.ev('wl_4','M3','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='m4')='processed' and (select v->>'link_status' from r where k='m4')='paid','tras mismatches, APPROVED correcta cierra el link');

-- desconocidos / malformados / firma
insert into r select 'u1', t.rec(t.ev('no_existe','X1','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='u1')='unknown_link' and (select v->>'link_id' from r where k='u1') is null and jsonb_array_length((select v->'deliveries' from r where k='u1'))=0,'link desconocido -> unknown_link, guardado, sin entrega');
select t.ok((select count(*) from payments.events where id=(select (v->>'event_id')::bigint from r where k='u1') and raw->'data'->'transaction'->>'id'='X1')=1,'unknown_link guarda el cuerpo crudo');
insert into r select 'u2', t.rec(t.ev(null,'X2','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='u2')='unknown_link','tx sin payment_link_id -> unknown_link');
insert into r select 'u3', t.rec('{"hola":1}','test',true);
select t.ok((select v->>'classification' from r where k='u3')='malformed','payload sin data.transaction -> malformed (y se guarda)');
insert into r select 'u4', t.rec('"texto"'::jsonb,'test',true);
select t.ok((select v->>'classification' from r where k='u4')='malformed','payload no-objeto -> malformed');
insert into r select 'u5', t.rec(null,'test',true);
select t.ok((select v->>'classification' from r where k='u5')='malformed','payload null -> malformed');
insert into r select 's1', t.rec(t.ev('wl_b','S1','APPROVED'),'test',false);
select t.ok((select v->>'classification' from r where k='s1')='invalid_signature' and (select status from payments.payment_links where wompi_link_id='wl_b')='pending' and jsonb_array_length((select v->'deliveries' from r where k='s1'))=0,'firma invalida -> invalid_signature, no cierra, no entrega');
insert into r select 'x1', t.rec(t.ev('wl_b','S2','APPROVED',5000000,'COP','prod'),'prod',true);
select t.ok((select v->>'classification' from r where k='x1')='unknown_link' and (select status from payments.payment_links where wompi_link_id='wl_b')='pending','evento prod sobre link sandbox -> unknown_link, no marca pagado');
-- proyecto sin callback
insert into r select 'b1', t.rec(t.ev('wl_b','S3','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='b1')='processed' and (select v->>'link_status' from r where k='b1')='paid' and jsonb_array_length((select v->'deliveries' from r where k='b1'))=0,'proyecto sin callback_url: procesa sin encolar');
-- todo evento quedo registrado
select t.ok((select count(*) from payments.events)=(select count(*) from r where k ~ '^(e|o|m|u|s|x|b)\d$'),'cada llamada a record_event dejo una fila en events');

-- sobre del aviso (§4)
select t.ok((select jsonb_typeof(body->'wompi')='object' and body->>'type'='payment_link.transaction'
              and body->>'id'=(select (v->>'event_id') from r where k='e3')
              and body->'payment_link'->>'external_reference'='REF-1' and body->'payment_link'->>'status'='paid'
              and (body->'payment_link'->>'amount_in_cents')::bigint=5000000 and body->'payment_link'->>'currency'='COP'
              and body->'payment_link'->'metadata'->>'k'='v' and body->>'classification'='processed'
              and body->'wompi' = (select raw from payments.events where id=(select (v->>'event_id')::bigint from r where k='e3'))
              and (body->>'created_at') ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$'
              and body->'payment_link'->>'id' = (select v->'link'->>'id' from ctx where k='L1')
             from payments.deliveries where id=((select v->'deliveries'->0->>'id' from r where k='e3')::uuid)),'sobre §4: claves, wompi = crudo, estado post-evento');
select t.ok((select body_sha256 from payments.deliveries where id=((select v->'deliveries'->0->>'id' from r where k='e3')::uuid)) = encode(sha256(convert_to((select body::text from payments.deliveries where id=((select v->'deliveries'->0->>'id' from r where k='e3')::uuid)),'UTF8')),'hex'),'body_sha256 corresponde al cuerpo');

-- ---- deliveries: claim, backoff, fallo definitivo ----
create temp table d(k text primary key, v jsonb);
grant all on d to service_role;
select t.ok((select count(*) from payments.deliveries where status='pending') >= 8, 'hay entregas pendientes');
insert into d select 'c1', public.payments_claim_deliveries(1000);
select t.ok(jsonb_array_length((select v from d where k='c1')) = (select count(*) from payments.deliveries where status='pending'),'claim reclama todas las vencidas');
select t.ok(jsonb_array_length(public.payments_claim_deliveries(1000))=0,'segundo claim no devuelve lo ya reclamado (lease)');
select t.ok((select (v->0->>'attempt')::int from d where k='c1')=1 and (select v->0 ? 'signing_secret_name' from d where k='c1') and (select v->0->'body' ? 'wompi' from d where k='c1'),'claim: attempt=1, signing_secret_name, body');
-- backoff completo sobre una entrega
create temp table one(id uuid);
grant all on one to service_role;
insert into one select ((select v->'deliveries'->0->>'id' from r where k='e1')::uuid);
create temp table bo(n int, status text, secs numeric);
grant all on bo to service_role;
do $$
declare v_id uuid := (select one.id from one); res jsonb; n int;
begin
  for n in 1..7 loop
    res := public.payments_complete_delivery(v_id, 500, 120, 'boom');
    insert into bo select n, res->>'status',
      case when res->>'next_attempt_at' is null then null else extract(epoch from ((res->>'next_attempt_at')::timestamptz - now())) end;
    update payments.deliveries set next_attempt_at = now() where id = v_id and status='pending';
  end loop;
end $$;
select t.ok((select array_agg(status order by n) from bo) = array['pending','pending','pending','pending','pending','pending','failed'],'backoff: 6 reintentos y el 7o intento -> failed');
select t.ok((select array_agg(round(secs/60) order by n) from bo where n<=6) = array[1,5,30,120,360,1440]::numeric[],'backoff: 1m,5m,30m,2h,6h,24h');
select t.ok((select count(*) from payments.delivery_attempts where delivery_id=(select id from one))=7,'7 filas en delivery_attempts');
select t.ok((select status from payments.deliveries where id=(select id from one))='failed','entrega queda failed');
select t.ok(not exists (select 1 from jsonb_array_elements(public.payments_claim_deliveries(1000)) x where (x->>'delivery_id')::uuid=(select id from one)),'failed no se vuelve a reclamar');
-- 2xx
insert into one select ((select v->'deliveries'->0->>'id' from r where k='e5')::uuid);
select t.ok((public.payments_complete_delivery((select id from one offset 1 limit 1),200,50,null)->>'status')='delivered','2xx -> delivered');
select t.ok((select delivered_at is not null and http_status=200 and last_error is null from payments.deliveries where id=(select id from one offset 1 limit 1)),'delivered_at/http_status');
select t.raises($$select public.payments_complete_delivery(gen_random_uuid(),200,1,null)$$,'PY404','complete inexistente');


-- ---- adiciones P2 (spec §6 items 14-18) ----
-- 14 find_link_by_wompi_id
select t.ok((public.payments_find_link_by_wompi_id('wl_1') ->> 'id') = (select v->'link'->>'id' from ctx where k='L1')
            and (public.payments_find_link_by_wompi_id('wl_1') ->> 'client_id') = (select v->>'id' from ctx where k='A')
            and (public.payments_find_link_by_wompi_id('wl_1') ->> 'environment') = 'sandbox'
            and (public.payments_find_link_by_wompi_id('wl_1') ->> 'status') = 'voided'
            and (public.payments_find_link_by_wompi_id('wl_1') ->> 'amount_in_cents') = '5000000'
            and (public.payments_find_link_by_wompi_id('wl_1') ->> 'currency') = 'COP'
            and (select count(*) from jsonb_object_keys(public.payments_find_link_by_wompi_id('wl_1'))) = 6,
  '14: find_link_by_wompi_id devuelve exactamente {id,client_id,environment,status,amount_in_cents,currency}');
select t.ok(public.payments_find_link_by_wompi_id('no_existe') is null and public.payments_find_link_by_wompi_id(null) is null,'14: find_link_by_wompi_id desconocido/null -> null');
select t.ok((select count(*) from payments.events) = (select count(*) from payments.events) and not exists (select 1 from payments.events where id > (select max(id) from payments.events)),'14: find_link_by_wompi_id es solo lectura (no registra eventos)');

-- 15a malformed con la forma de P2
insert into r select 'f1', t.rec('{"_malformed":true,"reason":"json invalido","raw_text":"{no es json"}'::jsonb,null,null);
select t.ok((select v->>'classification' from r where k='f1')='malformed' and (select v->>'link_id' from r where k='f1') is null,'15a: {_malformed:true,...} con env/firma null -> malformed');
select t.ok((select raw->>'raw_text' from payments.events where id=(select (v->>'event_id')::bigint from r where k='f1'))='{no es json','15a: malformed guarda raw_text');
-- 15b evento ajeno (resumen minimo, firma null)
insert into r select 'f2', t.rec(
  '{"event":"transaction.updated","environment":"test","sent_at":"2026-10-10T12:00:00.000Z","timestamp":1760097600,"data":{"transaction":{"id":"FOR1","status":"APPROVED","amount_in_cents":9900,"currency":"COP","payment_link_id":"otro_comercio"}}}'::jsonb,'sandbox',null);
select t.ok((select v->>'classification' from r where k='f2')='forwarded_foreign' and jsonb_array_length((select v->'deliveries' from r where k='f2'))=0 and (select v->>'link_id' from r where k='f2') is null,'15b: evento ajeno -> forwarded_foreign, sin entrega, sin link');
select t.ok((select environment='sandbox' and transaction_id='FOR1' and tx_status='APPROVED' and amount_in_cents=9900 and signature_valid is null and wompi_link_id='otro_comercio' and classification='forwarded_foreign' from payments.events where id=(select (v->>'event_id')::bigint from r where k='f2')),'15b: forwarded_foreign guarda resumen (env normalizado, signature_valid null)');
insert into r select 'f3', t.rec(
  '{"event":"transaction.updated","environment":"production","data":{"transaction":{"id":"FOR2","status":"APPROVED","amount_in_cents":1,"currency":"COP","payment_link_id":null}}}'::jsonb,'production',null);
select t.ok((select v->>'classification' from r where k='f3')='forwarded_foreign','15b: ajeno sin payment_link_id tambien forwarded_foreign');
-- una firma null sobre un link PROPIO nunca procesa
insert into r select 'f4', t.rec(t.ev('wl_b','FOR3','APPROVED'),'sandbox',null);
select t.ok((select v->>'classification' from r where k='f4')='invalid_signature' and jsonb_array_length((select v->'deliveries' from r where k='f4'))=0,'15b: firma null sobre link propio -> invalid_signature (nunca procesa)');
select t.ok((select count(*) from payments.events where classification='forwarded_foreign')=2,'15b: 2 forwarded_foreign registrados');

-- 16 http_status 0 = sin respuesta
insert into r select 'z1', t.rec(t.ev('wl_1','ZERO1','PENDING'),'test',true);
select t.ok((public.payments_complete_delivery((select (v->'deliveries'->0->>'id')::uuid from r where k='z1'),0,10000,'timeout')->>'status')='pending','16: http_status 0 -> pending con backoff (no delivered)');
select t.ok((select status='pending' and http_status=0 and attempt=1 and last_error='timeout' and next_attempt_at > now() + interval '30 seconds' and delivered_at is null from payments.deliveries where id=(select (v->'deliveries'->0->>'id')::uuid from r where k='z1')),'16: backoff 1 min, sin delivered_at');
select t.ok((select count(*) from payments.delivery_attempts where delivery_id=(select (v->'deliveries'->0->>'id')::uuid from r where k='z1') and http_status=0)=1,'16: intento con http_status 0 registrado');
insert into r select 'z2', t.rec(t.ev('wl_1','ZERO2','PENDING'),'test',true);
select public.payments_complete_delivery((select (v->'deliveries'->0->>'id')::uuid from r where k='z2'),0,1,null);
select t.ok((select last_error from payments.deliveries where id=(select (v->'deliveries'->0->>'id')::uuid from r where k='z2'))='sin respuesta HTTP','16: sin error informado -> last_error "sin respuesta HTTP"');

-- 17 last_event
select t.ok((select array_agg(k order by k) from jsonb_object_keys(public.payments_get_link((select (v->>'id')::uuid from ctx where k='A'),(select (v->'link'->>'id')::uuid from ctx where k='L1'),null)->'last_event') k)
            = array['amount_in_cents','classification','id','received_at','transaction_id','tx_status'],'17: last_event tiene exactamente id,classification,transaction_id,tx_status,amount_in_cents,received_at');
select t.ok((public.payments_get_link((select (v->>'id')::uuid from ctx where k='A'),(select (v->'link'->>'id')::uuid from ctx where k='L1'),null)->'last_event'->>'id')::bigint
            = (select max(id) from payments.events where link_id=(select (v->'link'->>'id')::uuid from ctx where k='L1')),'17: last_event es el evento mas reciente del link');
select t.ok((public.payments_get_link((select (v->>'id')::uuid from ctx where k='A'),(select (v->'link'->>'id')::uuid from ctx where k='L2'),null)->'last_event') = 'null'::jsonb,'17: last_event null si el link no tiene eventos');

-- list_links / admin_list_clients: formas esperadas por P2/P3
select t.ok((select bool_and(i ? 'client_name' and i ? 'environment' and i ? 'paid_at' and i ? 'checkout_url' and i ? 'client_id' and i ? 'external_reference'
                              and i ? 'amount_in_cents' and i ? 'currency' and i ? 'status' and i ? 'created_at' and i ? 'id')
               from jsonb_array_elements(public.payments_list_links(null,null,200,null)->'items') i),'list_links: items con client_name, environment, paid_at, checkout_url, ...');
select t.ok((select i->>'client_name' from jsonb_array_elements(public.payments_list_links(null,null,200,null)->'items') i where i->>'external_reference'='REF-3')='Proyecto A','list_links: client_name correcto');
select t.ok((select bool_and(c ? 'key_prefix' and c ? 'callback_url' and c ? 'created_at' and c ? 'revoked_at' and c ? 'id' and c ? 'name' and c ? 'status' and not c ? 'api_key_hash')
               from jsonb_array_elements(public.payments_admin_list_clients()) c),'admin_list_clients: key_prefix, callback_url, created_at, revoked_at y NUNCA api_key_hash');

-- 18 nombre de secreto con uuid aleatorio
create temp table sec(n text);
grant all on sec to service_role;
insert into sec select 'payments/' || gen_random_uuid() || '/signing';
select public.payments_store_secret((select n from sec),'whsec-xyz');
select t.ok((public.payments_admin_create_client('Proyecto C',null,repeat('c',64),'lxy_pay_test_cccccccc',(select n from sec),null)->>'signing_secret_name')=(select n from sec),'18: create_client acepta payments/<uuid>/signing');
select t.ok(public.payments_read_secret((select n from sec))='whsec-xyz' and public.payments_read_signing_secret_name((select (v->>'id')::uuid from payments.clients c, lateral (select to_jsonb(c) v) x where c.name='Proyecto C'))=(select n from sec),'18: store/read con nombre uuid y read_signing_secret_name');


-- ======================= RONDA 2 (spec §7.1) =======================
create or replace function pg_temp.cA() returns uuid language sql as $$ select id from payments.clients where name='Proyecto A' $$;
grant execute on function pg_temp.cA() to service_role;
select t.mklink(pg_temp.cA(),'r2-a','R2-A','wl_r2a');
select t.mklink(pg_temp.cA(),'r2-b','R2-B','wl_r2b');
select t.mklink((select id from payments.clients where name='Proyecto B'),'r2-c','R2-C','wl_r2c');

-- B1: replay cruzado
insert into r select 'x_a', t.rec(t.ev('wl_r2a','TX-R2','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='x_a')='processed' and (select v->>'link_status' from r where k='x_a')='paid','R2 B1: tx legitima paga su link A');
insert into r select 'x_b', t.rec(t.ev('wl_r2b','TX-R2','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='x_b')='transaction_conflict','R2 B1: misma transaction_id con OTRO link -> transaction_conflict');
select t.ok((select status from payments.payment_links where wompi_link_id='wl_r2b')='pending' and (select paid_transaction_id from payments.payment_links where wompi_link_id='wl_r2b') is null,'R2 B1: link B NO queda paid');
select t.ok(jsonb_array_length((select v->'deliveries' from r where k='x_b'))=0 and not exists (select 1 from payments.deliveries where event_id=(select (v->>'event_id')::bigint from r where k='x_b')),'R2 B1: sin aviso al proyecto');
select t.ok((select classification='transaction_conflict' and raw->'data'->'transaction'->>'id'='TX-R2' from payments.events where id=(select (v->>'event_id')::bigint from r where k='x_b')),'R2 B1: el evento sospechoso queda guardado');
insert into r select 'x_c', t.rec(t.ev('wl_r2c','TX-R2','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='x_c')='transaction_conflict' and (select status from payments.payment_links where wompi_link_id='wl_r2c')='pending','R2 B1: replay hacia el link de OTRO proyecto tambien se bloquea');
insert into r select 'x_d', t.rec(t.ev('wl_r2b','TX-R2','DECLINED'),'test',true);
select t.ok((select v->>'classification' from r where k='x_d')='transaction_conflict','R2 B1: conflicto aplica a cualquier status');
insert into r select 'x_e', t.rec(t.ev('wl_r2c','FOR1','APPROVED',9900),'test',true);
select t.ok((select v->>'classification' from r where k='x_e')='transaction_conflict','R2 B1: tx registrada como forwarded_foreign tampoco paga un link propio');
insert into r select 'x_f', t.rec(t.ev('wl_r2b','TX-R2-B','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='x_f')='processed' and (select v->>'link_status' from r where k='x_f')='paid','R2 B1: el pago legitimo de B (otra tx) si procesa');

-- sobre: transaction{}
select t.ok((select body->'transaction' = jsonb_build_object('id','TX-R2','status','APPROVED','amount_in_cents',5000000,'currency','COP')
             and (select count(*) from jsonb_object_keys(body->'transaction'))=4 from payments.deliveries where event_id=(select (v->>'event_id')::bigint from r where k='x_a')),'R2 sobre: transaction {id,status,amount_in_cents,currency} en la raiz');

-- unverified: sin p_verified no paga y no consume la dedupe
select t.mklink(pg_temp.cA(),'r2-d','R2-D','wl_r2d');
insert into r select 'uv1', public.payments_record_event(t.ev('wl_r2d','TX-UV','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='uv1')='unverified' and (select v->>'link_status' from r where k='uv1')='pending' and jsonb_array_length((select v->'deliveries' from r where k='uv1'))=0,'R2: APPROVED sin p_verified -> unverified, no paga, sin aviso');
insert into r select 'uv2', public.payments_record_event(t.ev('wl_r2d','TX-UV','APPROVED'),'test',true,null);
select t.ok((select v->>'classification' from r where k='uv2')='unverified','R2: reintento tambien sin verificar -> unverified (no duplicate)');
insert into r select 'uv3', t.rec(t.ev('wl_r2d','TX-UV','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='uv3')='processed' and (select v->>'link_status' from r where k='uv3')='paid' and jsonb_array_length((select v->'deliveries' from r where k='uv3'))=1,'R2: reintento CON p_verified procesa (la dedupe no se consumio)');
insert into r select 'uv4', public.payments_record_event(t.ev('wl_r2d','TX-UV','DECLINED'),'test',true);
select t.ok((select v->>'classification' from r where k='uv4')='processed','R2: DECLINED no exige verificacion');

-- verification_mismatch
select t.mklink(pg_temp.cA(),'r2-e','R2-E','wl_r2e');
create or replace function pg_temp.vm(label text, v jsonb) returns void language plpgsql as $$
declare res jsonb;
begin
  res := public.payments_record_event(t.ev('wl_r2e','TX-VM','APPROVED'),'test',true,v);
  perform t.ok(res->>'classification'='verification_mismatch' and res->>'link_status'='pending' and jsonb_array_length(res->'deliveries')=0, 'R2: verification_mismatch por '||label);
end $$;
grant execute on function pg_temp.vm(text,jsonb) to service_role;
select pg_temp.vm('payment_link_id distinto', jsonb_build_object('id','TX-VM','status','APPROVED','amount_in_cents',5000000,'currency','COP','payment_link_id','wl_r2b'));
select pg_temp.vm('monto distinto', jsonb_build_object('id','TX-VM','status','APPROVED','amount_in_cents',4999999,'currency','COP','payment_link_id','wl_r2e'));
select pg_temp.vm('moneda distinta', jsonb_build_object('id','TX-VM','status','APPROVED','amount_in_cents',5000000,'currency','USD','payment_link_id','wl_r2e'));
select pg_temp.vm('status distinto', jsonb_build_object('id','TX-VM','status','PENDING','amount_in_cents',5000000,'currency','COP','payment_link_id','wl_r2e'));
select pg_temp.vm('id distinto', jsonb_build_object('id','OTRA','status','APPROVED','amount_in_cents',5000000,'currency','COP','payment_link_id','wl_r2e'));
select pg_temp.vm('payment_link_id null', jsonb_build_object('id','TX-VM','status','APPROVED','amount_in_cents',5000000,'currency','COP','payment_link_id',null));
select pg_temp.vm('_not_found', '{"_not_found": true}'::jsonb);
select t.ok((select status from payments.payment_links where wompi_link_id='wl_r2e')='pending','R2: tras 7 mismatches el link sigue pending');
insert into r select 'vm9', t.rec(t.ev('wl_r2e','TX-VM','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='vm9')='processed','R2: verificacion correcta posterior si procesa (mismatch no consume dedupe)');

-- voided
select t.mklink(pg_temp.cA(),'r2-f','R2-F','wl_r2f');
insert into r select 'vo1', t.rec(t.ev('wl_r2f','TX-V1','APPROVED'),'test',true);
insert into r select 'vo2', t.rec(t.ev('wl_r2f','TX-OTRA','VOIDED'),'test',true);
select t.ok((select v->>'classification' from r where k='vo2')='processed' and (select v->>'link_status' from r where k='vo2')='paid','R2: VOIDED de otra tx no cambia el link');
insert into r select 'vo3', t.rec(t.ev('wl_r2f','TX-V1','VOIDED'),'test',true);
select t.ok((select v->>'classification' from r where k='vo3')='processed' and (select v->>'link_status' from r where k='vo3')='voided','R2: VOIDED de la tx pagada -> link voided');
select t.ok((select count(*) from payments.link_status_history h join payments.payment_links l on l.id=h.link_id where l.wompi_link_id='wl_r2f' and h.from_status='paid' and h.to_status='voided' and h.cause='transaction_voided' and h.event_id=(select (v->>'event_id')::bigint from r where k='vo3'))=1,'R2: historial transaction_voided con event_id');
select t.ok((select body->'payment_link'->>'status'='voided' and body->'transaction'->>'status'='VOIDED' and body->>'classification'='processed' from payments.deliveries where id=(select (v->'deliveries'->0->>'id')::uuid from r where k='vo3')),'R2: sobre con payment_link.status=voided y transaction.status=VOIDED');
insert into r select 'vo4', t.rec(t.ev('wl_r2f','TX-V2','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='vo4')='duplicate_payment' and (select v->>'link_status' from r where k='vo4')='voided','R2: APPROVED posterior NO revive el link voided (duplicate_payment)');
insert into r select 'vo5', t.rec(t.ev('wl_r2f','TX-V1','APPROVED'),'test',true);
select t.ok((select v->>'classification' from r where k='vo5')='duplicate' and (select status from payments.payment_links where wompi_link_id='wl_r2f')='voided','R2: reenvio de la APPROVED original tampoco lo revive');
insert into r select 'vo6', t.rec(t.ev('wl_r2f','TX-V1','VOIDED'),'test',true);
select t.ok((select v->>'classification' from r where k='vo6')='duplicate','R2: VOIDED repetida -> duplicate');

-- sent_sha256
select t.mklink(pg_temp.cA(),'r2-g','R2-G','wl_r2g');
insert into r select 'sh1', t.rec(t.ev('wl_r2g','TX-SH','PENDING'),'test',true);
select public.payments_complete_delivery((select (v->'deliveries'->0->>'id')::uuid from r where k='sh1'),200,12,null,repeat('ab',32));
select t.ok((select sent_sha256 from payments.delivery_attempts where delivery_id=(select (v->'deliveries'->0->>'id')::uuid from r where k='sh1'))=repeat('ab',32),'R2: complete_delivery guarda sent_sha256 en delivery_attempts');
insert into r select 'sh2', t.rec(t.ev('wl_r2g','TX-SH2','PENDING'),'test',true);
select public.payments_complete_delivery((select (v->'deliveries'->0->>'id')::uuid from r where k='sh2'),500,12,'x');
select t.ok((select sent_sha256 is null from payments.delivery_attempts where delivery_id=(select (v->'deliveries'->0->>'id')::uuid from r where k='sh2')),'R2: sin p_sent_sha256 (4 args, compat) queda null');

-- suspended no reclama
select public.payments_admin_set_callback((select id from payments.clients where name='Proyecto C'),'https://c.example/h','payments/C/signing');
select t.mklink((select id from payments.clients where name='Proyecto C'),'r2-h','R2-H','wl_r2h');
insert into r select 'su1', t.rec(t.ev('wl_r2h','TX-SU','PENDING'),'test',true);
select t.ok(jsonb_array_length((select v->'deliveries' from r where k='su1'))=1,'R2: entrega encolada para C');
select public.payments_admin_set_client_status((select id from payments.clients where name='Proyecto C'),'suspended');
select t.ok(not exists (select 1 from jsonb_array_elements(public.payments_claim_deliveries(1000)) x where (x->>'delivery_id')::uuid=(select (v->'deliveries'->0->>'id')::uuid from r where k='su1')),'R2: cliente suspended -> claim_deliveries no la reclama');
select t.ok((select status='pending' from payments.deliveries where id=(select (v->'deliveries'->0->>'id')::uuid from r where k='su1')),'R2: la entrega queda pending (no se pierde)');
update payments.deliveries set next_attempt_at = now() where id=(select (v->'deliveries'->0->>'id')::uuid from r where k='su1');
select public.payments_admin_set_client_status((select id from payments.clients where name='Proyecto C'),'active');
select t.ok(exists (select 1 from jsonb_array_elements(public.payments_claim_deliveries(1000)) x where (x->>'delivery_id')::uuid=(select (v->'deliveries'->0->>'id')::uuid from r where k='su1')),'R2: al reactivar el cliente, la entrega se reclama');

-- health_summary
select t.mklink(pg_temp.cA(),'r2-s','R2-S','wl_r2s');
insert into r select 'st1', public.payments_record_event(t.ev('wl_r2s','TX-ST','APPROVED'),'test',true);
reset role;
update payments.payment_links set created_at = now() - interval '2 days' where wompi_link_id='wl_r2s';
set role service_role;
create temp table hs as select public.payments_health_summary() h;
grant all on hs to service_role;
select t.ok((select array_agg(k order by k) from hs, jsonb_object_keys(h) k) = array['amount_mismatch','deliveries_failed','duplicate_payment','invalid_signature','legacy_not_applied','stale_pending_links','transaction_conflict','unverified','verification_mismatch'],'R2: health_summary tiene exactamente las 9 claves (legacy_not_applied agregada en la fusion del webhook)');
select t.ok((select (h->>'invalid_signature')::int from hs) = (select count(*) from payments.events where classification='invalid_signature')
        and (select (h->>'unverified')::int from hs) = (select count(*) from payments.events where classification='unverified')
        and (select (h->>'verification_mismatch')::int from hs) = 7
        and (select (h->>'transaction_conflict')::int from hs) = 4
        and (select (h->>'amount_mismatch')::int from hs) = (select count(*) from payments.events where classification='amount_mismatch')
        and (select (h->>'duplicate_payment')::int from hs) = (select count(*) from payments.events where classification='duplicate_payment')
        and (select (h->>'deliveries_failed')::int from hs) = (select count(*) from payments.deliveries where status='failed'),'R2: health_summary conteos coinciden con events/deliveries');
select t.ok((select (h->>'stale_pending_links')::int from hs) = 1,'R2: stale_pending_links = link pending >24h con evento unverified');
select t.ok((public.payments_health_summary(0)->>'unverified')::int >= 0 and (select (public.payments_health_summary(1)->>'transaction_conflict')::int) = 4,'R2: health_summary(p_hours) acota la ventana');

-- ---- redaccion ----
insert into r select 'p1', t.rec(
  t.ev('wl_3','PII1','DECLINED',5000000,'COP','test', jsonb_build_object('customer_email','juan@example.com',
       'customer_data', jsonb_build_object('full_name','Juan Perez','phone_number','3001234567'),
       'payment_method', jsonb_build_object('type','CARD','extra',jsonb_build_object('last_four','4242','name','Juan')),
       'shipping_address', jsonb_build_object('address_line_1','Calle 1'))),'test',true);
select t.ok((select raw->'data'->'transaction'->>'customer_email' from payments.events where id=(select (v->>'event_id')::bigint from r where k='p1'))='juan@example.com','antes: raw trae email');
reset role;
alter table payments.events disable trigger events_append_only;
update payments.events set received_at = now() - interval '100 days' where id=(select (v->>'event_id')::bigint from r where k='p1') or id=(select (v->>'event_id')::bigint from r where k='e1');
alter table payments.events enable trigger events_append_only;
set role service_role;
create temp table pre as select count(*) n from payments.events;
grant all on pre to service_role;
select t.ok((public.payments_redact_events()->>'redacted')::int = 2,'redact: 2 eventos de mas de 90 dias');
select t.ok((select count(*) from payments.events)=(select n from pre),'redact no borra filas');
select t.ok((select raw->'data'->'transaction' ? 'customer_email' or raw->'data'->'transaction' ? 'customer_data' or raw->'data'->'transaction' ? 'shipping_address' from payments.events where id=(select (v->>'event_id')::bigint from r where k='p1')) is false,'redact: sin email/customer_data/shipping_address');
select t.ok((select raw->'data'->'transaction'->'payment_method' from payments.events where id=(select (v->>'event_id')::bigint from r where k='p1'))='{"type":"CARD"}'::jsonb,'redact: payment_method reducido a type');
select t.ok((select transaction_id='PII1' and tx_status='DECLINED' and amount_in_cents=5000000 and raw_redacted_at is not null and raw->'data'->'transaction'->>'id'='PII1' from payments.events where id=(select (v->>'event_id')::bigint from r where k='p1')),'redact conserva resumen y marca raw_redacted_at');
select t.ok((select body->'wompi'->'data'->'transaction' ? 'customer_email' from payments.deliveries where event_id=(select (v->>'event_id')::bigint from r where k='p1')) is false,'redact tambien limpia deliveries.body.wompi');
select t.ok((public.payments_redact_events()->>'redacted')::int = 0,'redact es idempotente');
select t.ok((select raw_redacted_at is null from payments.events where id=(select (v->>'event_id')::bigint from r where k='e3')),'eventos recientes no se tocan');
select t.raises($$select public.payments_redact_events(interval '1 hour')$$,'PY422','redact rechaza ventanas < 1 dia');
select t.raises($$update payments.events set raw='{}' where raw_redacted_at is not null$$,'PY423','fuera de payments_redact_events no se puede reescribir raw');

-- ---- secretos ----
select public.payments_store_secret('payments/A/signing','s3cr3t');
select t.ok(public.payments_read_secret('payments/A/signing')='s3cr3t','store/read secret');
select public.payments_store_secret('payments/A/signing','nuevo');
select t.ok(public.payments_read_secret('payments/A/signing')='nuevo','store actualiza');
select t.raises($$select public.payments_store_secret('cron_reminder_secret','x')$$,'PY422','store rechaza nombre sin prefijo');
select t.raises($$select public.payments_read_secret('cron_reminder_secret')$$,'PY422','read rechaza nombre sin prefijo');
select t.raises($$select public.payments_read_secret('payments/zzz')$$,'PY404','read inexistente');
select t.ok(public.payments_read_signing_secret_name((select (v->>'id')::uuid from ctx where k='A'))='payments/A/signing','read_signing_secret_name');
select t.ok(public.payments_read_signing_secret_name((select (v->>'id')::uuid from ctx where k='B')) is null,'read_signing_secret_name null si no hay');

-- ---- admin: rotate / callback ----
select t.ok(public.payments_lookup_client(repeat('a',64)) is not null,'antes de rotar la clave vieja sirve');
select public.payments_admin_rotate_key((select (v->>'id')::uuid from ctx where k='A'),repeat('e',64),'lxy_pay_test_eeeeeeee');
select t.ok(public.payments_lookup_client(repeat('a',64)) is null and public.payments_lookup_client(repeat('e',64)) is not null,'rotate_key invalida la clave anterior');
select t.ok((public.payments_admin_set_callback((select (v->>'id')::uuid from ctx where k='B'),'https://b.example/h','payments/B/signing')->>'callback_url')='https://b.example/h','set_callback');
select t.raises($$select public.payments_admin_set_callback((select (v->>'id')::uuid from ctx where k='B'),'ftp://b','payments/B/signing')$$,'PY422','set_callback https obligatorio');
select t.raises($$select public.payments_admin_set_callback((select (v->>'id')::uuid from ctx where k='B'),'https://b.example/h','otro/B')$$,'PY422','set_callback prefijo payments/');
select t.ok(jsonb_array_length(public.payments_admin_list_clients())>=2 and not (public.payments_admin_list_clients()->0 ? 'api_key_hash'),'list_clients sin hash');
select t.ok(not exists (select 1 from jsonb_array_elements(public.payments_admin_list_clients()) c where c ? 'api_key_hash'),'ningun cliente listado expone hash');

-- ---- cron ----
reset role;
select t.ok((select count(*) from cron.job where jobname in ('payments-dispatch','payments-redact-events'))=2,'cron: 2 jobs registrados');
select t.ok((select schedule from cron.job where jobname='payments-dispatch')='* * * * *','cron: dispatch cada minuto');
delete from net.calls;
select public.payments_trigger_dispatch();
select t.ok((select count(*) from net.calls)=0,'dispatch sin secreto -> no llama');
insert into vault.secrets(name, secret) values ('cron_reminder_secret_test','SECRETO-CRON');
insert into public.internal_secrets select 'cron_reminder_secret', id from vault.secrets where name='cron_reminder_secret_test';
update payments.deliveries set next_attempt_at = now() - interval '1 minute' where id=(select (v->'deliveries'->0->>'id')::uuid from r where k='e2');
select public.payments_trigger_dispatch();
select t.ok((select count(*) from net.calls)=1 and (select url from net.calls)='https://kkdtrkfcnyvuefazndnj.supabase.co/functions/v1/payments-api/internal/dispatch' and (select headers->>'Authorization' from net.calls)='Bearer SECRETO-CRON','dispatch con secreto y entrega vencida -> http_post con Bearer del secreto');
update payments.deliveries set status='delivered' where status='pending';
delete from net.calls;
select public.payments_trigger_dispatch();
select t.ok((select count(*) from net.calls)=0,'dispatch sin entregas vencidas -> no llama');
delete from public.internal_secrets;
