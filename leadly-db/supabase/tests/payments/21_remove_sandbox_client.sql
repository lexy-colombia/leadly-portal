-- Prueba de la migracion 20261016150000_remove_sandbox_payments_client.sql en el
-- Postgres descartable (nunca toca una base real). Se carga DESPUES de aplicar la
-- migracion del esquema; este archivo arma el escenario y vuelve a ejecutar el cuerpo
-- de la migracion (psql \i) para cada caso. Salida: lineas PASS/FAIL como el resto.
\set ON_ERROR_STOP off
set client_min_messages = notice;

create or replace function pg_temp.ok(p_name text, p_cond boolean) returns void language plpgsql as $$
begin
  if p_cond then raise notice 'PASS %', p_name; else raise notice 'FAIL: %', p_name; end if;
end $$;

-- escenario exacto de produccion: 1 cliente 'Leadly' external con 1 link sandbox,
-- 3 filas de historial y 1 evento enlazado; mas 3 eventos SIN link que NO deben tocarse.
create or replace function pg_temp.scenario(p_env text default 'sandbox', p_history int default 3) returns void language plpgsql as $$
declare v_link uuid := '88441392-5856-49c9-ba34-5922ae1b3288';
begin
  insert into payments.clients (id, name, api_key_hash, key_prefix, signing_secret_name)
  values ('bbd10ad5-484a-4619-8ecc-33db41f1cd30', 'Leadly', repeat('a', 64), 'lxy_pay_te', 'payments/398a4a04-b5e1-450c-860a-1f4090d161c7/signing')
  on conflict do nothing;
  insert into vault.secrets (name, secret) values ('payments/398a4a04-b5e1-450c-860a-1f4090d161c7/signing', 'x') on conflict do nothing;
  insert into payments.payment_links (id, client_id, wompi_link_id, external_reference, idempotency_key, request_hash,
    amount_in_cents, currency, environment, name, description, status)
  values (v_link, 'bbd10ad5-484a-4619-8ecc-33db41f1cd30', 'test_3lleMV', 'ref', 'k1', 'h', 1000, 'COP', p_env, 'n', 'd', 'paid')
  on conflict do nothing;
  insert into payments.events (id, classification, link_id, wompi_link_id, transaction_id, tx_status, raw)
  overriding system value values (4, 'processed', v_link, 'test_3lleMV', 'tx-1', 'APPROVED', '{}') on conflict do nothing;
  insert into payments.events (id, classification, raw) overriding system value
  values (1, 'malformed', '{}'), (2, 'malformed', '{}'), (3, 'malformed', '{}') on conflict do nothing;
  -- como en produccion: UNA fila del historial referencia al evento enlazado (event_id=4)
  insert into payments.link_status_history (link_id, to_status, cause, event_id)
  select v_link, 'x', 'c', case when g = p_history then 4 end from generate_series(1, p_history) g;
end $$;

\set mig `echo "$MIG_REMOVE"`

-- 1) base sin el cliente: no hace nada y no falla
\i :mig
select pg_temp.ok('sin cliente: no hace nada', (select count(*) from payments.clients where id = 'bbd10ad5-484a-4619-8ecc-33db41f1cd30') = 0);

-- 2) conteos distintos (4 filas de historial) => aborta y NO borra nada ni deja triggers apagados
select pg_temp.scenario('sandbox', 4);
\i :mig
select pg_temp.ok('conteo inesperado: el cliente sigue', (select count(*) from payments.clients where name = 'Leadly') = 1);
select pg_temp.ok('conteo inesperado: el link sigue', (select count(*) from payments.payment_links) = 1);
select pg_temp.ok('conteo inesperado: triggers siguen habilitados',
  (select count(*) from pg_trigger where tgname in ('events_append_only', 'link_status_history_append_only') and tgenabled = 'O') = 2);
delete from payments.link_status_history where false;  -- (no-op: confirma que la tabla sigue accesible)

-- limpieza manual del caso 2 (se deshabilita el trigger solo para reiniciar el escenario)
alter table payments.events disable trigger events_append_only;
alter table payments.link_status_history disable trigger link_status_history_append_only;
delete from payments.link_status_history; delete from payments.events; delete from payments.payment_links; delete from payments.clients;
delete from vault.secrets where name like 'payments/%';
alter table payments.events enable trigger events_append_only;
alter table payments.link_status_history enable trigger link_status_history_append_only;

-- 3) link que no es sandbox => aborta
select pg_temp.scenario('production', 3);
\i :mig
select pg_temp.ok('link production: no se borra', (select count(*) from payments.payment_links where environment = 'production') = 1);
alter table payments.events disable trigger events_append_only;
alter table payments.link_status_history disable trigger link_status_history_append_only;
delete from payments.link_status_history; delete from payments.events; delete from payments.payment_links; delete from payments.clients;
delete from vault.secrets where name like 'payments/%';
alter table payments.events enable trigger events_append_only;
alter table payments.link_status_history enable trigger link_status_history_append_only;

-- 4) escenario exacto => borra cliente, link, historial, el evento enlazado y el secreto; deja el resto
select pg_temp.scenario('sandbox', 3);
\i :mig
select pg_temp.ok('exacto: cliente borrado', (select count(*) from payments.clients) = 0);
select pg_temp.ok('exacto: link borrado', (select count(*) from payments.payment_links) = 0);
select pg_temp.ok('exacto: historial borrado', (select count(*) from payments.link_status_history) = 0);
select pg_temp.ok('exacto: evento enlazado borrado', (select count(*) from payments.events where link_id is not null) = 0);
select pg_temp.ok('exacto: los 3 eventos sin link siguen', (select count(*) from payments.events) = 3);
select pg_temp.ok('exacto: secreto del Vault borrado', (select count(*) from vault.secrets where name like 'payments/398a%') = 0);
select pg_temp.ok('exacto: triggers vuelven a estar habilitados',
  (select count(*) from pg_trigger where tgname in ('events_append_only', 'link_status_history_append_only') and tgenabled = 'O') = 2);

-- 5) las protecciones siguen funcionando despues (no se puede borrar un evento a mano)
do $$ begin
  begin
    delete from payments.events where id = 1;
    raise notice 'FAIL: el trigger solo-insertar no bloqueo el delete';
  exception when sqlstate 'PY423' then raise notice 'PASS solo-insertar sigue activo tras la migracion';
  end;
end $$;

-- 6) idempotente: segunda ejecucion no hace nada ni falla
\i :mig
select pg_temp.ok('idempotente: segunda corrida sin efecto', (select count(*) from payments.events) = 3);
