-- payments_public_link_status: forma minima, last_attempt solo de eventos validos,
-- privilegios. Se ejecuta COMO service_role despues de 15_legacy.sql (esquema t).
set role service_role;
\set ON_ERROR_STOP 1

select t.ok(public.payments_public_link_status(null) = '{"found":false,"status":null,"last_attempt":null,"updated_at":null}'::jsonb, 'null -> found=false, todo null');
select t.ok(public.payments_public_link_status(gen_random_uuid())->>'found' = 'false', 'id inexistente -> found=false');

select t.mklink((select id from payments.clients where name='Proyecto A'), 'pub-k1', 'PUB-1', 'wl-pub-1') as lk \gset
select t.ok((select array_agg(k order by k) from jsonb_object_keys(public.payments_public_link_status(:'lk'::uuid)) k) = array['found','last_attempt','status','updated_at'],
  'claves exactas del RPC');
select t.ok(public.payments_public_link_status(:'lk'::uuid)->>'status' = 'pending' and public.payments_public_link_status(:'lk'::uuid)->'last_attempt' = 'null'::jsonb, 'link pending sin eventos');

select public.payments_record_event(t.ev('wl-pub-1','tp-1','DECLINED'),'test',true,null);
select t.ok(public.payments_public_link_status(:'lk'::uuid)->>'last_attempt' = 'DECLINED', 'DECLINED valido -> last_attempt');
select public.payments_record_event(t.ev('wl-pub-1','tp-2','DECLINED'),'test',false,null);
select public.payments_record_legacy_event(t.ev('wl-pub-1','tp-3','ERROR'),'test',false,'invalid_signature',null,null);
select t.ok(public.payments_public_link_status(:'lk'::uuid)->>'last_attempt' = 'DECLINED', 'invalid_signature NO cuenta como intento');

-- origen legacy: por origin_ref
select public.payments_record_legacy_event(t.ev('wl-pub-inv','tp-4','APPROVED'),'test',true,'legacy_invoice','legacy_invoice','11111111-1111-4111-8111-111111111111',5000000,'COP');
select t.ok(public.payments_public_link_status('11111111-1111-4111-8111-111111111111')->>'found' = 'false'
        and public.payments_public_link_status('11111111-1111-4111-8111-111111111111')->>'last_attempt' = 'APPROVED', 'legacy: found=false y last_attempt por origin_ref');

-- privilegios
reset role;
select t.ok(not has_function_privilege('anon','public.payments_public_link_status(uuid)','execute')
        and not has_function_privilege('authenticated','public.payments_public_link_status(uuid)','execute')
        and has_function_privilege('service_role','public.payments_public_link_status(uuid)','execute'), 'solo service_role ejecuta');
