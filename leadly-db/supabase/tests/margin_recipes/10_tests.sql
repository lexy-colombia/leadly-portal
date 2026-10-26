create schema t; create table t.r(n serial, name text, ok boolean, detail text);
-- fixture
insert into tenants values ('a0000000-0000-0000-0000-000000000001'),('b0000000-0000-0000-0000-000000000002');
\set A '''a0000000-0000-0000-0000-000000000001'''
\set B '''b0000000-0000-0000-0000-000000000002'''
insert into materials(id,tenant_id,name,cost) values
 ('10000000-0000-0000-0000-000000000001',:A,'harina',2.5),
 ('10000000-0000-0000-0000-000000000002',:A,'carne',10.25),
 ('10000000-0000-0000-0000-000000000003',:A,'sin costo',0),
 ('10000000-0000-0000-0000-000000000004',:B,'ajeno',999);
insert into materials(id,tenant_id,name,cost,deleted_at) values ('10000000-0000-0000-0000-000000000005',:A,'retirado',4,now());
insert into products(id,tenant_id,name,purchase_price,inventory_mode) values
 ('20000000-0000-0000-0000-000000000001',:A,'stock con costo',3,'stock'),
 ('20000000-0000-0000-0000-000000000002',:A,'stock sin costo',null,'stock'),
 ('20000000-0000-0000-0000-000000000003',:A,'receta ok',null,'recipe'),
 ('20000000-0000-0000-0000-000000000004',:A,'receta insumo cero',null,'recipe'),
 ('20000000-0000-0000-0000-000000000005',:A,'receta vacia',null,'recipe'),
 ('20000000-0000-0000-0000-000000000006',:A,'receta retirado',null,'recipe'),
 ('20000000-0000-0000-0000-000000000007',:A,'receta insumo ajeno',null,'recipe'),
 ('20000000-0000-0000-0000-000000000008',:A,'receta ficha ajena',null,'recipe');
insert into product_bom(tenant_id,product_id,material_id,quantity) values
 (:A,'20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001',0.3333),
 (:A,'20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000002',0.5),
 (:A,'20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001',1),
 (:A,'20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000003',1),
 (:A,'20000000-0000-0000-0000-000000000006','10000000-0000-0000-0000-000000000005',2),
 (:A,'20000000-0000-0000-0000-000000000007','10000000-0000-0000-0000-000000000004',1),
 (:B,'20000000-0000-0000-0000-000000000008','10000000-0000-0000-0000-000000000001',1),
 -- ficha de OTRO tenant sobre un producto del A: no debe contar
 (:B,'20000000-0000-0000-0000-000000000005','10000000-0000-0000-0000-000000000004',1);
insert into sales_orders(id,tenant_id,status) values ('30000000-0000-0000-0000-000000000001',:A,'confirmada');
insert into sales_order_items(order_id,product_id,product_name,quantity,subtotal) values
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','stock con costo',2,100),
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','stock sin costo',1,50),
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003','receta ok',3,300),
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','receta insumo cero',1,40),
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000005','receta vacia',1,30),
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000006','receta retirado',1,20),
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000007','receta insumo ajeno',1,10),
 ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000008','receta ficha ajena',1,10),
 ('30000000-0000-0000-0000-000000000001',null,'linea libre',1,5);
create temp table gm as
 select r->>'product_name' pn, (r->>'estimated_cost')::numeric c, (r->>'estimated_margin')::numeric m, r->>'cost_source' src,
        r ? 'estimated_cost' has_key
 from jsonb_array_elements(public.get_reports_product_summary(:A::uuid, now()-interval '1 day', now()+interval '1 day', 20)->'gross_margin') r;
create function t.chk(nm text, cond boolean, d text default null) returns void language sql as $$ insert into t.r(name,ok,detail) values (nm, coalesce(cond,false), d) $$;
select t.chk('stock con costo: 2*3=6, margen 94, fuente purchase_price', (select c=6 and m=94 and src='purchase_price' from gm where pn='stock con costo'));
select t.chk('stock sin costo: desconocido', (select c is null and m is null and src is null from gm where pn='stock sin costo'));
-- 3*(0.3333*2.5 + 0.5*10.25) = 3*5.95825 = 17.87475
select t.chk('receta ok: suma con decimales', (select c=17.87475 and m=300-17.87475 and src='recipe' from gm where pn='receta ok'), (select c::text from gm where pn='receta ok'));
select t.chk('receta con insumo en 0: desconocido', (select c is null and m is null and src is null from gm where pn='receta insumo cero'));
select t.chk('receta sin ficha (ni la ficha de otro tenant cuenta): desconocido', (select c is null and m is null and src is null from gm where pn='receta vacia'));
select t.chk('receta con insumo retirado: costo conocido (2*4=8)', (select c=8 and src='recipe' from gm where pn='receta retirado'));
select t.chk('insumo de otro tenant no cuenta: desconocido', (select c is null and src is null from gm where pn='receta insumo ajeno'));
select t.chk('fila de ficha de otro tenant no cuenta: desconocido', (select c is null and src is null from gm where pn='receta ficha ajena'));
select t.chk('linea libre sin product_id: desconocido', (select c is null and m is null and src is null from gm where pn='linea libre'));
select t.chk('tenant B no ve nada del A', jsonb_array_length(public.get_reports_product_summary(:B::uuid, now()-interval '1 day', now()+interval '1 day', 20)->'gross_margin')=0);
select t.chk('las demas claves de salida siguen', (select count(*)=7 from jsonb_object_keys(public.get_reports_product_summary(:A::uuid, now()-interval '1 day', now()+interval '1 day')) ));
select case when ok then 'PASS  ' else 'FAIL  ' end || name || case when ok then '' else ' -- '||coalesce(detail,'') end from t.r order by n;
