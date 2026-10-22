-- Prueba de 20261016155000_remove_sandbox_wompi_test_data.sql en un Postgres
-- descartable (nunca toca una base real). Arma un esquema `public` MINIMO que replica
-- lo que importa de produccion: el trigger de inmutabilidad (delete de pagos de pedidos
-- fuera de cotizacion), las FK en cascada desde credit_charges / store_credit_redemptions
-- y las tablas que lee la migracion. Se ejecuta con MIG_REMOVE_DATA=<ruta de la migracion>.
\set ON_ERROR_STOP off
set client_min_messages = notice;

create or replace function pg_temp.ok(p_name text, p_cond boolean) returns void language plpgsql as $$
begin
  if p_cond then raise notice 'PASS %', p_name; else raise notice 'FAIL: %', p_name; end if;
end $$;

drop schema if exists public cascade; create schema public;
create table public.sales_orders (id uuid primary key, tenant_id uuid not null, status text not null);
create table public.sales_order_payments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, order_id uuid not null references public.sales_orders(id),
  method text not null, amount numeric not null default 0, provider_key text, provider_transaction_id text,
  payment_link_id uuid, deleted_at timestamptz);
create table public.sales_order_payment_links (
  id uuid primary key, tenant_id uuid not null, order_id uuid, provider_key text not null,
  provider_checkout_id text not null, status text not null default 'pending');
create table public.sales_invoices (id uuid primary key default gen_random_uuid(), order_id uuid, status text not null);
create table public.credit_charges (id uuid primary key default gen_random_uuid(),
  sales_order_payment_id uuid references public.sales_order_payments(id) on delete cascade);
create table public.store_credit_redemptions (id uuid primary key default gen_random_uuid(),
  sales_order_payment_id uuid references public.sales_order_payments(id) on delete cascade);

-- copia fiel del guard real (20260822020001_customer_credit.sql)
create or replace function public.guard_sales_order_payment_immutable() returns trigger language plpgsql as $$
declare v_status text;
begin
  select status into v_status from public.sales_orders where id = old.order_id;
  if v_status is distinct from 'cotizacion' then
    raise exception 'No se puede modificar ni eliminar un pago de una orden que ya no esta en cotizacion (estado actual: %)', v_status;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger trg_sales_order_payments_immutable_delete before delete on public.sales_order_payments
  for each row execute function public.guard_sales_order_payment_immutable();
create trigger trg_sales_order_payments_immutable_update before update on public.sales_order_payments
  for each row execute function public.guard_sales_order_payment_immutable();

\set mig `echo "$MIG_REMOVE_DATA"`

-- escenario: los mismos ids que produccion (6 pagos en 4 pedidos confirmados + 13 links)
create or replace function pg_temp.scenario() returns void language plpgsql as $$
declare
  t uuid := 'cb195047-8cd2-4e38-9964-62bb99911814';
  pays uuid[] := array['a7e71715-1231-476e-be15-9460d9d9174c','be8f6620-7425-44d2-bb43-038a03eac067','2dfeb904-009d-4f85-a74e-8fde4fe5f3b9','5c8b96b5-e3dd-4dee-803a-4d2284f1f06d','7ef107be-2bee-4f90-96cb-f347a89344e6','8202284f-f36a-4929-ac30-116f6a0d14ca']::uuid[];
  lnk uuid[] := array['48508231-fbdb-4a50-bf5b-b8da4b329ec9','9fde9d59-73ef-42e9-913d-8632d8a86f3c','bfdfa8ee-e2e2-44a1-8e12-ee0320fc5c21','f4281d47-c463-40d4-ab26-36501138de02','1ef6b160-7051-41d0-ae5f-e9ac7637b74c','5080742d-1564-4b1a-887f-f92cbfc89688','5a7b818e-598c-47c3-81d6-d79a3289e058','89876270-5f9a-42ec-9c73-98aa15fdcac6','cb098b34-56c6-4815-a71a-ee8078bc6d82','d564272d-d72a-4130-88d0-c13eff031241','f4f7480f-fe39-41ef-ae18-7bc088dfec56','f99fd298-115b-446e-bdeb-904649a11870','af1fe37d-42b2-44fb-a73a-80a9d2b56743']::uuid[];
  orders uuid[] := array['852ed7c6-f28e-4e33-8e54-13c1851b9574','bdd48d28-f3c2-434d-aae0-1e996b196544','edd568ca-2262-496f-9623-6fb2b2401962','0cc0611e-92e5-4471-bfa6-0cfb50458384']::uuid[];
  i int;
begin
  for i in 1..4 loop insert into public.sales_orders values (orders[i], t, 'confirmada') on conflict do nothing; end loop;
  -- 6 pagos: 1,1,1 y 3 sobre el ultimo pedido
  insert into public.sales_order_payments (id, tenant_id, order_id, method, amount, provider_key, provider_transaction_id) values
   (pays[1], t, orders[1], 'wompi', 163000, 'wompi', 'tx1'), (pays[2], t, orders[2], 'wompi', 88000, 'wompi', 'tx2'),
   (pays[3], t, orders[3], 'wompi', 127000, 'wompi', 'tx3'), (pays[4], t, orders[4], 'wompi', 1197000, 'wompi', 'tx4'),
   (pays[5], t, orders[4], 'wompi', 1197000, 'wompi', 'tx5'), (pays[6], t, orders[4], 'wompi', 1197000, 'wompi', 'tx6');
  for i in 1..13 loop
    insert into public.sales_order_payment_links (id, tenant_id, provider_key, provider_checkout_id, status)
    values (lnk[i], t, 'wompi', 'test_' || i, case when i in (5,6,7,9,11,12) then 'paid' else 'pending' end);
  end loop;
end $$;

create or replace function pg_temp.reset() returns void language plpgsql as $$
begin
  alter table public.sales_order_payments disable trigger trg_sales_order_payments_immutable_delete;
  delete from public.credit_charges; delete from public.store_credit_redemptions;
  delete from public.sales_order_payments; delete from public.sales_order_payment_links;
  delete from public.sales_invoices; delete from public.sales_orders;
  alter table public.sales_order_payments enable trigger trg_sales_order_payments_immutable_delete;
end $$;

create or replace function pg_temp.trg_on() returns boolean language sql as $$
  select (select tgenabled from pg_trigger where tgname = 'trg_sales_order_payments_immutable_delete') = 'O'
$$;

-- 1) base vacia: no hace nada
\i :mig
select pg_temp.ok('base vacia: no hace nada y no falla', true);

-- 2) otro pago wompi fuera de la lista => aborta, no borra nada
select pg_temp.scenario();
insert into public.sales_order_payments (tenant_id, order_id, method, amount, provider_key)
  values ('cb195047-8cd2-4e38-9964-62bb99911814', '852ed7c6-f28e-4e33-8e54-13c1851b9574', 'wompi', 1, 'wompi');
\i :mig
select pg_temp.ok('pago wompi extra: no borra', (select count(*) from public.sales_order_payments) = 7);
select pg_temp.ok('pago wompi extra: links intactos', (select count(*) from public.sales_order_payment_links) = 13);
select pg_temp.ok('pago wompi extra: trigger sigue habilitado', pg_temp.trg_on());
select pg_temp.reset();

-- 3) un link que no es de prueba => aborta
select pg_temp.scenario();
update public.sales_order_payment_links set provider_checkout_id = 'REAL_123' where id = '48508231-fbdb-4a50-bf5b-b8da4b329ec9';
\i :mig
select pg_temp.ok('link no-test: no borra', (select count(*) from public.sales_order_payments) = 6);
select pg_temp.reset();

-- 4) otro tenant => aborta
select pg_temp.scenario();
alter table public.sales_order_payments disable trigger trg_sales_order_payments_immutable_update;
update public.sales_order_payments set tenant_id = gen_random_uuid() where id = 'a7e71715-1231-476e-be15-9460d9d9174c';
alter table public.sales_order_payments enable trigger trg_sales_order_payments_immutable_update;
select pg_temp.ok('preparacion otro tenant: el pago cambio de tenant', (select tenant_id from public.sales_order_payments where id = 'a7e71715-1231-476e-be15-9460d9d9174c') <> 'cb195047-8cd2-4e38-9964-62bb99911814');
\i :mig
select pg_temp.ok('otro tenant: no borra', (select count(*) from public.sales_order_payments) = 6);
select pg_temp.reset();

-- 5) un cargo a credito dependiente (cascada!) => aborta y NO lo arrastra
select pg_temp.scenario();
insert into public.credit_charges (sales_order_payment_id) values ('be8f6620-7425-44d2-bb43-038a03eac067');
\i :mig
select pg_temp.ok('dependiente de credito: no borra pagos', (select count(*) from public.sales_order_payments) = 6);
select pg_temp.ok('dependiente de credito: el cargo sigue', (select count(*) from public.credit_charges) = 1);
select pg_temp.reset();

-- 6) factura enviada ante la DIAN => aborta
select pg_temp.scenario();
insert into public.sales_invoices (order_id, status) values ('bdd48d28-f3c2-434d-aae0-1e996b196544', 'accepted');
\i :mig
select pg_temp.ok('factura aceptada: no borra', (select count(*) from public.sales_order_payments) = 6);
select pg_temp.reset();

-- 7) factura bloqueada (como produccion) NO impide la limpieza; el trigger bloquea el delete manual
select pg_temp.scenario();
insert into public.sales_invoices (order_id, status) values ('bdd48d28-f3c2-434d-aae0-1e996b196544', 'blocked_missing_buyer_data');
do $$ begin
  begin
    delete from public.sales_order_payments where id = 'a7e71715-1231-476e-be15-9460d9d9174c';
    raise notice 'FAIL: el trigger de inmutabilidad no bloqueo un delete manual';
  exception when others then raise notice 'PASS el trigger de inmutabilidad bloquea el delete manual (%)', sqlerrm;
  end;
end $$;
\i :mig
select pg_temp.ok('exacto: 6 pagos borrados', (select count(*) from public.sales_order_payments) = 0);
select pg_temp.ok('exacto: 13 links borrados', (select count(*) from public.sales_order_payment_links) = 0);
select pg_temp.ok('exacto: los 4 pedidos siguen (solo se borraron pagos)', (select count(*) from public.sales_orders) = 4);
select pg_temp.ok('exacto: la factura bloqueada sigue', (select count(*) from public.sales_invoices) = 1);
select pg_temp.ok('exacto: trigger de inmutabilidad vuelve a estar habilitado', pg_temp.trg_on());

-- 8) despues de la migracion el trigger sigue protegiendo
select pg_temp.scenario();
do $$ begin
  begin
    delete from public.sales_order_payments where id = 'a7e71715-1231-476e-be15-9460d9d9174c';
    raise notice 'FAIL: el trigger no protege despues de la migracion';
  exception when others then raise notice 'PASS el trigger sigue protegiendo tras la migracion';
  end;
end $$;
select pg_temp.reset();

-- 9) idempotente
\i :mig
select pg_temp.ok('idempotente: segunda corrida no hace nada', (select count(*) from public.sales_order_payments) = 0);
