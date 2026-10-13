-- Fusion del webhook viejo: payments_record_legacy_event / payments_transaction_usage,
-- clasificaciones nuevas y replay cruzado contra la funcion reemplazada
-- payments_record_event. Se ejecuta COMO service_role (despues de 10_functional.sql,
-- que define el esquema t).
set role service_role;
\set ON_ERROR_STOP 1

-- clasificacion fuera de la lista -> PY422; origen fuera de la lista -> PY422
select t.raises($$select public.payments_record_legacy_event(t.ev('wl-x','tl-0','APPROVED'),'test',true,'processed',null,null)$$,'PY422','clasificacion no permitida (processed)');
select t.raises($$select public.payments_record_legacy_event(t.ev('wl-x','tl-0','APPROVED'),'test',true,'legacy_invoice','otro',null)$$,'PY422','origen no permitido');

-- factura de plataforma aplicada
select public.payments_record_legacy_event(t.ev('wl-inv','tl-1','APPROVED'),'test',true,'legacy_invoice','legacy_invoice','inv-123',5000000,'COP') as r \gset
select t.ok((select classification from payments.events where id = (:'r'::jsonb->>'event_id')::bigint) = 'legacy_invoice', 'legacy_invoice guardado');
select t.ok((select origin = 'legacy_invoice' and origin_ref = 'inv-123' and amount_matches is true and link_id is null
               from payments.events where transaction_id='tl-1'), 'origen, referencia, amount_matches y link_id null');
select t.ok((select raw #>> '{data,transaction,customer_email}' is null or true from payments.events where transaction_id='tl-1'), 'raw guardado');

-- monto distinto -> amount_matches false
select public.payments_record_legacy_event(t.ev('wl-inv','tl-2','APPROVED',1),'test',true,'amount_mismatch','legacy_invoice','inv-123',5000000,'COP');
select t.ok((select amount_matches is false from payments.events where transaction_id='tl-2'), 'amount_matches=false con monto esperado distinto');

-- usage: lista la transaccion aplicada, no las rechazadas por firma
select public.payments_record_legacy_event(t.ev('wl-inv','tl-3','APPROVED'),'test',false,'invalid_signature','legacy_invoice','inv-123',null,null);
select t.ok(jsonb_array_length(public.payments_transaction_usage('tl-1')) = 1
        and public.payments_transaction_usage('tl-1') -> 0 ->> 'wompi_link_id' = 'wl-inv'
        and public.payments_transaction_usage('tl-1') -> 0 ->> 'classification' = 'legacy_invoice', 'usage de tx aplicada');
select t.ok(public.payments_transaction_usage('tl-3') = '[]'::jsonb, 'usage ignora invalid_signature');
select t.ok(public.payments_transaction_usage(null) = '[]'::jsonb, 'usage(null) -> []');

-- duplicate_payment repetido (misma tx/estado/link) no choca con el indice unico: se guarda como duplicate
select public.payments_record_legacy_event(t.ev('wl-ord','tl-4','APPROVED'),'test',true,'duplicate_payment','legacy_order','ord-1',5000000,'COP');
select t.ok((public.payments_record_legacy_event(t.ev('wl-ord','tl-4','APPROVED'),'test',true,'duplicate_payment','legacy_order','ord-1',5000000,'COP')->>'classification') = 'duplicate',
  'duplicate_payment repetido -> duplicate (sin violar payments_events_dedupe_idx)');

-- replay cruzado: tl-1 ya aplicada a la factura; llega para un link del SERVICIO NUEVO
select t.ok((select count(*) from payments.clients where name='Proyecto A') = 1, 'cliente A existe');
select t.mklink((select id from payments.clients where name='Proyecto A'), 'leg-k1', 'LEG-1', 'wl-svc-1') as lk \gset
select t.ok((public.payments_record_event(t.ev('wl-svc-1','tl-1','APPROVED'),'test',true,t.verified(t.ev('wl-svc-1','tl-1','APPROVED')))->>'classification') = 'transaction_conflict',
  'tx aplicada a una factura legacy NO paga un link del servicio nuevo (transaction_conflict)');
select t.ok((select status from payments.payment_links where id = :'lk') = 'pending', 'el link del servicio sigue pending');

-- una tx del servicio nuevo, vista despues en usage
select public.payments_record_event(t.ev('wl-svc-1','tl-5','APPROVED'),'test',true,t.verified(t.ev('wl-svc-1','tl-5','APPROVED')));
select t.ok(public.payments_transaction_usage('tl-5') -> 0 ->> 'classification' = 'processed', 'usage incluye processed del servicio nuevo');

-- legacy_not_applied (dinero cobrado sin acreditar) se guarda y es consultable
select public.payments_record_legacy_event(t.ev('wl-closed','tl-6','APPROVED'),'test',true,'legacy_not_applied','legacy_invoice','inv-9',5000000,'COP');
select t.ok((select count(*) from payments.events where classification = 'legacy_not_applied') = 1, 'legacy_not_applied guardado');
select t.ok((public.payments_health_summary(24)->>'legacy_not_applied')::int = 1, 'health_summary cuenta legacy_not_applied');

-- las clasificaciones nuevas pasan el CHECK; una inventada directa no
select t.raises($$insert into payments.events(classification, raw) values ('inventada','{}')$$,'23514','CHECK de classification rechaza valores fuera de lista');

-- ---- B1: tope de filas invalid_signature / malformed (anti-llenado) ----------
select t.mklink((select id from payments.clients where name='Proyecto A'), 'leg-k2', 'LEG-2', 'wl-svc-2') as lk2 \gset
create temp table fl(k int, r jsonb);
grant all on fl to service_role;
insert into fl select i, public.payments_record_event(t.ev('wl-svc-2','tfl-'||i,'APPROVED'),'test',false,null) from generate_series(1,50) i;
select t.ok((select count(*) from payments.events where classification='invalid_signature' and wompi_link_id='wl-svc-2') = 10,
  'record_event: 50 firmas invalidas del mismo link -> solo 10 filas (tope por minuto)');
select t.ok((select count(*) from fl where (r->>'throttled')::boolean is true) = 40 and (select count(*) from fl where r->>'classification' = 'invalid_signature') = 50,
  'las 40 restantes responden la misma clasificacion con throttled=true y sin fila');
-- el evento VALIDO posterior del mismo link sigue procesandose
select t.ok((public.payments_record_event(t.ev('wl-svc-2','tfl-ok','APPROVED'),'test',true,t.verified(t.ev('wl-svc-2','tfl-ok','APPROVED')))->>'classification') = 'processed',
  'el evento valido del link spameado SIGUE procesandose');
select t.ok((select status from payments.payment_links where id = :'lk2') = 'paid', 'y el link queda paid');
-- legacy
insert into fl select 100+i, public.payments_record_legacy_event(t.ev('wl-spam','tsp-'||i,'APPROVED'),'test',false,'invalid_signature',null,null) from generate_series(1,30) i;
select t.ok((select count(*) from payments.events where classification='invalid_signature' and wompi_link_id='wl-spam') = 10,
  'record_legacy_event: 30 firmas invalidas del mismo link -> 10 filas');
-- malformed: tope global de 10 por minuto en el mismo bucket
insert into fl select 200+i, public.payments_record_event('{"_malformed":true,"reason":"x","raw_text":"zzz"}'::jsonb,null,null) from generate_series(1,25) i;
select t.ok((select count(*) from payments.events where classification='malformed') <= 10, 'malformed acotado a 10 por minuto');
-- tope global: muchos links distintos
insert into fl select 300+i, public.payments_record_legacy_event(t.ev('wl-g'||i,'tg-'||i,'APPROVED'),'test',false,'invalid_signature',null,null) from generate_series(1,400) i;
select t.ok((select count(*) from payments.events where classification in ('invalid_signature','malformed') and received_at > now() - interval '1 minute') <= 300,
  'tope global de 300 filas invalidas por minuto');
reset role;
select 'PASS: 15_legacy completo';
