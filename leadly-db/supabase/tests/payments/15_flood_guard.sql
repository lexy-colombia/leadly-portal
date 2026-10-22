-- Guardia anti-llenado de la bandeja (B1) y replay cruzado contra eventos historicos,
-- sobre payments_record_event (la unica funcion de registro tras el retiro de la rama
-- legacy). Se ejecuta COMO service_role (despues de 10_functional.sql, que define el esquema t).
set role service_role;
\set ON_ERROR_STOP 1

-- las clasificaciones historicas legacy_* siguen en el CHECK (payments.events es solo-insertar),
-- aunque ya ninguna funcion las crea; una inventada no pasa
select t.raises($$insert into payments.events(classification, raw) values ('inventada','{}')$$,'23514','CHECK de classification rechaza valores fuera de lista');
reset role;
insert into payments.events(classification, raw, transaction_id, tx_status, wompi_link_id, origin, origin_ref)
  values ('legacy_invoice', '{}', 'tl-1', 'APPROVED', 'wl-inv', 'legacy_invoice', 'inv-123');
set role service_role;
select t.ok((select count(*) from payments.events where classification = 'legacy_invoice') = 1, 'fila historica legacy_invoice insertable (CHECK conservado)');

-- replay cruzado: tl-1 ya aplicada (historia) a una factura; llega para un link del servicio
select t.ok((select count(*) from payments.clients where name='Proyecto A') = 1, 'cliente A existe');
select t.mklink((select id from payments.clients where name='Proyecto A'), 'leg-k1', 'LEG-1', 'wl-svc-1') as lk \gset
select t.ok((public.payments_record_event(t.ev('wl-svc-1','tl-1','APPROVED'),'test',true,t.verified(t.ev('wl-svc-1','tl-1','APPROVED')))->>'classification') = 'transaction_conflict',
  'una tx aplicada historicamente por la rama retirada NO paga un link del servicio (transaction_conflict)');
select t.ok((select status from payments.payment_links where id = :'lk') = 'pending', 'el link del servicio sigue pending');

-- un evento sin link en el servicio (firma valida) queda unknown_link; con firma invalida, invalid_signature
select t.ok((public.payments_record_event(t.ev('wl-nolink','tn-1','APPROVED'),'test',true)->>'classification') = 'unknown_link', 'sin link + firma valida -> unknown_link');
select t.ok((public.payments_record_event(t.ev('wl-nolink','tn-2','APPROVED'),'test',false)->>'classification') = 'invalid_signature', 'sin link + firma invalida -> invalid_signature');
select t.ok((select link_id is null and origin is null and origin_ref is null from payments.events where transaction_id = 'tn-1'), 'unknown_link sin link_id ni origen');

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
-- link inexistente (el caso que antes iba por la funcion legacy): mismo tope
insert into fl select 100+i, public.payments_record_event(t.ev('wl-spam','tsp-'||i,'APPROVED'),'test',false) from generate_series(1,30) i;
select t.ok((select count(*) from payments.events where classification='invalid_signature' and wompi_link_id='wl-spam') = 10,
  'firmas invalidas de un link inexistente: 30 -> 10 filas');
-- malformed: tope global de 10 por minuto en el mismo bucket
insert into fl select 200+i, public.payments_record_event('{"_malformed":true,"reason":"x","raw_text":"zzz"}'::jsonb,null,null) from generate_series(1,25) i;
select t.ok((select count(*) from payments.events where classification='malformed') <= 10, 'malformed acotado a 10 por minuto');
-- tope global: muchos links distintos
insert into fl select 300+i, public.payments_record_event(t.ev('wl-g'||i,'tg-'||i,'APPROVED'),'test',false) from generate_series(1,400) i;
select t.ok((select count(*) from payments.events where classification in ('invalid_signature','malformed') and received_at > now() - interval '1 minute') <= 300,
  'tope global de 300 filas invalidas por minuto');
reset role;
select 'PASS: 15_flood_guard completo';
