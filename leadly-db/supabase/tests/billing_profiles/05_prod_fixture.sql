-- Datos con la FORMA de produccion, ANTES de las migraciones S1 (se aplican sobre
-- el esquema REAL reconstruido con todas las migraciones previas, ver run.sh).
set client_min_messages = warning;
create schema if not exists t;
grant usage on schema t to public;
create table t.ids(k text primary key, id uuid);
grant all on t.ids to public;
create function t.id(p_k text) returns uuid language sql stable as $$ select id from t.ids where k = p_k $$;

-- usuarios de dos tenants (para RLS)
create function t.mkuser(p_k text, p_tenant text, p_role text default 'tenant_admin') returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users(id, email) values (v, p_k || '@t.test');
  insert into public.profiles(id, tenant_id, full_name, email, role) values (v, t.id(p_tenant), p_k, p_k || '@t.test', p_role);
  insert into t.ids values (p_k, v); return v;
end $$;

create function t.client(p_k text, p_t text, p_name text, p_phone text, p_doctype text, p_doc text,
                         p_email text default null, p_bp jsonb default '{}'::jsonb, p_withh boolean default false,
                         p_deleted boolean default false) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.clients(tenant_id, full_name, phone, email, dian_document_type_code, document_number, billing_profile,
                             applies_withholding, deleted_at)
  values (t.id(p_t), p_name, p_phone, p_email, p_doctype, p_doc, p_bp, p_withh, case when p_deleted then now() end)
  returning id into v;
  insert into t.ids values (p_k, v); return v;
end $$;

create function t.addr(p_k text, p_t text, p_c text, p_line1 text, p_ship boolean, p_bill boolean, p_default boolean default false,
                       p_city text default 'Medellín', p_city_code text default '05001') returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.contact_addresses(tenant_id, contact_id, line1, is_shipping, is_billing, is_default, city, city_code, state_code, country, recipient_name, phone)
  values (t.id(p_t), t.id(p_c), p_line1, p_ship, p_bill, p_default, p_city, p_city_code, case when p_city_code is not null then substr(p_city_code, 1, 2) end, 'Colombia', 'Dest ' || p_k, '3001112222')
  returning id into v;
  insert into t.ids values (p_k, v); return v;
end $$;

-- tenants (el trigger siembra bodega, pipeline y el cliente Consumidor Final)
insert into public.tenants(name) values ('zz A'), ('zz B');
insert into t.ids select 'A', id from public.tenants where name = 'zz A';
insert into t.ids select 'B', id from public.tenants where name = 'zz B';
insert into t.ids select 'A_w1', id from public.warehouses where tenant_id = t.id('A') limit 1;
insert into t.ids select 'A_walkin', id from public.clients where tenant_id = t.id('A') and is_walk_in;
insert into t.ids select 'B_walkin', id from public.clients where tenant_id = t.id('B') and is_walk_in;
select t.mkuser('uA', 'A'); select t.mkuser('uB', 'B');
select t.mkuser('uAdmin', 'A', 'tenant_admin');

-- === clientes de A ===
-- completo, NIT, con domicilio resuelto
select t.client('c_full', 'A', 'Acme Cliente', '3101', '31', '900123456-7', 'comprador@acme.co',
  '{"legal_name":"Acme SAS","tax_level_code":"O-13","tax_scheme_code":"01","email":"fact@acme.co","delivery_method":"email","address":{"line1":"Cra 1 #2-3","city":"Medellín","state_province":"Antioquia","country":"CO","city_code":"05001","state_code":"05"}}');
-- sin correo en ningun lado
select t.client('c_noemail', 'A', 'Sin Correo', '3102', '13', '1010', null, '{"legal_name":"Sin Correo SA"}');
-- DANE ambiguo (dos "Belén") y sin departamento
select t.client('c_belen', 'A', 'Belen Ambiguo', '3103', '13', '2020', 'b@x.co', '{"address":{"line1":"Calle 9","city":"Belén","country":"CO"}}');
-- Belén con departamento -> inequivoco
select t.client('c_belen_st', 'A', 'Belen Boyaca', '3104', '13', '2021', 'bb@x.co', '{"address":{"line1":"Calle 10","city":"Belén","state_province":"Boyacá","country":"CO"}}');
-- municipio por nombre unico
select t.client('c_medellin', 'A', 'Medellin Nombre', '3105', '13', '2022', 'm@x.co', '{"address":{"line1":"Calle 11","city":"Medellín","country":"CO"}}');
-- dos direcciones fiscales candidatas, sin predeterminada -> sin domicilio elegido
select t.client('c_two', 'A', 'Dos Fiscales', '3106', '13', '3030', 'two@x.co', '{}');
-- solo retencion, sin documento -> elegible e incompleto
select t.client('c_withh', 'A', 'Solo Retencion', '3107', null, null, null, '{}', true);
-- sin datos fiscales -> no elegible
select t.client('c_nodata', 'A', 'Sin Datos', '3108', null, null, null, '{}');
-- eliminado con documento -> no elegible
select t.client('c_deleted', 'A', 'Eliminado', '3109', '13', '4040', 'd@x.co', '{}', false, true);
-- extranjero
select t.client('c_foreign', 'A', 'Foreign', '3110', '22', 'X99', 'f@x.co', '{"address":{"line1":"1 Main St","city":"Miami","state_province":"FL","country":"US"}}');
-- codigos DIVIPOLA validos pero sin pais declarado
select t.client('c_codes', 'A', 'Codes Sin Pais', '3111', '13', '5050', 'cc@x.co', '{"address":{"line1":"Calle 12","city":"Bogotá","city_code":"11001","state_code":"11"}}');
-- codigos incoherentes (municipio de otro departamento) -> se descartan
select t.client('c_badgeo', 'A', 'Geo Incoherente', '3112', '13', '5051', 'bg@x.co', '{"address":{"line1":"Calle 13","country":"CO","city_code":"05001","state_code":"11"}}');
-- cliente "normal" de venta con direccion de envio (para confirmar pedidos)
select t.client('c_ship', 'A', 'Con Envio', '3113', '13', '6060', 'ship@x.co', '{"legal_name":"Con Envio","email":"ship@x.co"}');
select t.client('c_other', 'A', 'Otro Cliente', '3114', '13', '6061', 'o@x.co', '{"legal_name":"Otro","email":"o@x.co"}');
-- tenant B
select t.client('b_c1', 'B', 'B Cliente', '3201', '13', '1010', 'b1@x.co', '{"legal_name":"B Uno"}');

-- direcciones
select t.addr('a_full_1', 'A', 'c_full', 'Cra 1 #2-3', true, true, true);
select t.addr('a_full_dup', 'A', 'c_full', 'CRA 1 # 2 - 3', true, false, false);       -- duplicado normalizado de a_full_1
select t.addr('a_two_1', 'A', 'c_two', 'Av Fiscal 1', false, true);
select t.addr('a_two_2', 'A', 'c_two', 'Av Fiscal 2', false, true);
select t.addr('a_bonly', 'A', 'c_noemail', 'Solo Fact 1', false, true);
select t.addr('a_ship', 'A', 'c_ship', 'Calle Envio 5', true, false, true);
select t.addr('a_other', 'A', 'c_other', 'Calle Otro 7', true, false, true);
select t.addr('b_a1', 'B', 'b_c1', 'Cra B 1', true, true, true);

-- Un producto con stock para confirmar pedidos
insert into public.products(tenant_id, name, track_inventory) values (t.id('A'), 'prod', true);
insert into t.ids select 'prod', id from public.products where tenant_id = t.id('A') and name = 'prod';
insert into public.product_stock(tenant_id, product_id, warehouse_id, quantity) values (t.id('A'), t.id('prod'), t.id('A_w1'), 100);

-- credencial DIAN activa en A (hace que se reserve la factura al confirmar)
insert into public.integration_credentials(tenant_id, provider_key, is_active) values (t.id('A'), 'dian_directo', true);

-- pedidos preexistentes (insert directo, updated_at fijo para verificar que el backfill no lo mueve)
create function t.order(p_k text, p_c text, p_channel text, p_status text default 'cotizacion', p_ship text default null) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.sales_orders(tenant_id, contact_id, sales_channel, status, shipping_address_id, subtotal, total, created_at, updated_at)
  values (t.id('A'), t.id(p_c), p_channel, p_status, case when p_ship is null then null else t.id(p_ship) end, 1000, 1000, '2026-01-01', '2026-01-02')
  returning id into v;
  insert into public.sales_order_items(tenant_id, order_id, product_id, product_name, quantity, unit_price, subtotal)
  values (t.id('A'), v, t.id('prod'), 'prod', 1, 1000, 1000);
  insert into t.ids values (p_k, v); return v;
end $$;
select t.order('o_pos', 'c_full', 'pos', 'confirmada');
select t.order('o_portal', 'c_ship', 'portal', 'cotizacion', 'a_ship');
select t.order('o_wa', 'c_ship', 'whatsapp', 'confirmada');
select t.order('o_null', 'c_ship', null, 'cotizacion');
-- pedidos para el candado
select t.order('o_acc', 'c_ship', 'portal', 'confirmada', 'a_ship');
select t.order('o_pend', 'c_ship', 'portal', 'confirmada', 'a_ship');
select t.order('o_sent_cn', 'c_ship', 'portal', 'confirmada', 'a_ship');
select t.order('o_part_cn', 'c_ship', 'portal', 'confirmada', 'a_ship');
select t.order('o_rej', 'c_ship', 'portal', 'confirmada', 'a_ship');
select t.order('o_none', 'c_ship', 'portal', 'confirmada', 'a_ship');
-- tenant B tiene un pedido pos tambien
insert into public.sales_orders(tenant_id, contact_id, sales_channel, status, created_at, updated_at)
values (t.id('B'), t.id('b_c1'), 'pos', 'confirmada', '2026-01-01', '2026-01-02');

insert into public.sales_invoices(tenant_id, order_id, status, total) values
  (t.id('A'), t.id('o_acc'), 'accepted', 1000),
  (t.id('A'), t.id('o_pend'), 'pending', 1000),
  (t.id('A'), t.id('o_sent_cn'), 'sent', 1000),
  (t.id('A'), t.id('o_part_cn'), 'accepted', 1000),
  (t.id('A'), t.id('o_rej'), 'rejected', 1000);
insert into public.sales_credit_notes(tenant_id, invoice_id, order_id, status, reason_code, reason_description, total)
select t.id('A'), i.id, i.order_id, 'accepted', '1', 'Devolucion total de la mercancia', 1000
  from public.sales_invoices i where i.order_id = t.id('o_sent_cn');
insert into public.sales_credit_notes(tenant_id, invoice_id, order_id, status, reason_code, reason_description, total)
select t.id('A'), i.id, i.order_id, 'accepted', '1', 'Devolucion parcial de la mercancia', 400
  from public.sales_invoices i where i.order_id = t.id('o_part_cn');

-- foto de lo que NO debe cambiar
create table t.snap as
select (select md5(string_agg(c::text, '|' order by c.id)) from public.clients c) as clients_md5,
       (select count(*) from public.clients) as clients_n,
       (select updated_at from public.sales_orders where id = t.id('o_portal')) as o_portal_updated,
       (select updated_at from public.contact_addresses where id = t.id('a_full_1')) as addr_updated;
