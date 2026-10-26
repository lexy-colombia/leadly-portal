set client_min_messages = warning;
set check_function_bodies = off;
create table t.ids(k text primary key, id uuid);
grant all on t.ids to public;
create function t.id(p_k text) returns uuid language sql stable as $$ select id from t.ids where k = p_k $$;

-- tenant + bodega por defecto 'W1' (id en t.ids: <k>_w1)
create function t.tenant(p_k text) returns uuid language plpgsql as $$
declare v uuid; w uuid;
begin
  insert into public.tenants(name) values ('zz ' || p_k) returning id into v;
  insert into public.warehouses(tenant_id, name, is_default) values (v, 'W1', true) returning id into w;
  insert into t.ids values (p_k, v), (p_k || '_w1', w);
  return v;
end $$;
create function t.wh2(p_k text) returns uuid language plpgsql as $$
declare w uuid;
begin
  insert into public.warehouses(tenant_id, name) values (t.id(p_k), 'W2') returning id into w;
  insert into t.ids values (p_k || '_w2', w); return w;
end $$;
-- producto con stock en W1 (y variantes opcionales)
create function t.product(p_k text, p_t text, p_qty numeric, p_track boolean default true) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.products(tenant_id, name, track_inventory) values (t.id(p_t), p_k, p_track) returning id into v;
  insert into t.ids values (p_k, v);
  if p_qty is not null then
    insert into public.product_stock(tenant_id, product_id, warehouse_id, quantity) values (t.id(p_t), v, t.id(p_t || '_w1'), p_qty);
  end if;
  return v;
end $$;
create function t.setstock(p_p text, p_w uuid, p_qty numeric, p_variant uuid default null) returns void language sql as $$
  insert into public.product_stock(tenant_id, product_id, warehouse_id, variant_id, quantity)
  select tenant_id, id, p_w, p_variant, p_qty from public.products where id = t.id(p_p)
  on conflict do nothing;
  update public.product_stock set quantity = p_qty where product_id = t.id(p_p) and warehouse_id = p_w and variant_id is not distinct from p_variant; $$;
create function t.cart(p_k text, p_t text, p_origin text default 'pos') returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.carts(tenant_id, origin) values (t.id(p_t), p_origin) returning id into v;
  insert into t.ids values (p_k, v); return v;
end $$;
-- guarda un carrito con items [(producto, cantidad[, bodega, variante])] via save_cart_lines (la ruta real del POS)
create function t.save(p_c text, p_t text, p_items jsonb) returns jsonb language sql as $$
  select public.save_cart_lines(t.id(p_c), t.id(p_t), '{}'::jsonb, p_items) $$;
create function t.line(p_p text, p_q numeric, p_w uuid default null, p_v uuid default null) returns jsonb language sql as $$
  select jsonb_build_object('product_id', t.id(p_p), 'variant_id', p_v, 'warehouse_id', p_w, 'product_name', p_p, 'sku', null, 'quantity', p_q, 'unit_price', 1000) $$;
create function t.avail(p_p text, p_t text, p_w uuid default null, p_excl uuid default null) returns numeric language sql as $$
  select public.stock_available(t.id(p_t), t.id(p_p), null, p_w, p_excl) $$;
create function t.phys(p_p text) returns numeric language sql as $$
  select coalesce(sum(quantity), 0) from public.product_stock where product_id = t.id(p_p) $$;
create function t.resv(p_c text) returns numeric language sql as $$
  select coalesce(sum(quantity), 0) from public.stock_reservations where cart_id = t.id(p_c) $$;
