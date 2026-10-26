-- Barriles de la sexta: carga de insumos y fichas técnicas (recetas) de los platos con peso definido.
-- Brief: progress/brief_barriles_fichas.md. Depende de 20261027120000/130000 (materials, product_bom,
-- products.inventory_mode, módulo `materials`).
--
-- Qué hace (todo acotado al tenant fijo, con guardas que ABORTAN si algo no cuadra):
--   1. Habilita el módulo `materials` (tenant_enabled_modules, source 'manual': la sincronización del plan
--      nunca toca filas 'manual').
--   2. Crea 12 insumos (costo 0, sin existencias, min_stock null), idempotente por lower(name).
--   3. Crea las fichas (product_bom) de 35 productos y los pasa a inventory_mode = 'recipe'.
-- Efecto operativo: los productos en 'recipe' no se pueden vender hasta cargar existencias de sus insumos
-- (los insumos nacen en 0). Las existencias propias de esos productos (product_stock) no se tocan: dejan de
-- contar. Las reservas de stock propio de esos productos se liberan por trigger al cambiar el modo.
-- Los productos que no están en la lista (Costilla ahumada, Parrillada, etc.) quedan en modo 'stock'.

do $$
declare
  v_tenant constant uuid := '9c79437d-1c19-4edc-bc1f-0dc06094823a';
  v_name text;
  v_n int;
  v_bad text;
  v_dup text;
  v_missing text;
  v_var text;
  v_open_cart_items int;
  v_open_carts int;
  v_mats int;
  v_boms int;
  v_recipes int;
begin
  -- 1. Guarda de tenant
  select name into v_name from public.tenants where id = v_tenant;
  if v_name is distinct from 'Barriles de la sexta' then
    raise exception 'Guarda: el tenant % no es Barriles de la sexta (%).', v_tenant, v_name;
  end if;

  create temporary table _fm_materials (name text primary key, unit text not null) on commit drop;
  insert into _fm_materials values
    ('Lomo de res', 'kg'), ('Lomo de cerdo', 'kg'), ('Pechuga de pollo', 'kg'), ('Pierna pernil de pollo', 'kg'),
    ('Filete de pescado', 'kg'), ('Trucha', 'kg'), ('Mojarra', 'kg'), ('Bagre', 'kg'), ('Bocachico', 'kg'),
    ('Mixtura de mariscos', 'kg'), ('Chorizo', 'un'), ('Huevo', 'un');

  create temporary table _fm_bom (product_name text not null, material_name text not null, qty numeric(14,4) not null,
                                  primary key (product_name, material_name)) on commit drop;
  insert into _fm_bom values
    ('Menú ejecutivo - lomo de res', 'Lomo de res', 0.130),
    ('Porción de proteína - lomo de res', 'Lomo de res', 0.130),
    ('Menú ejecutivo - lomo de cerdo', 'Lomo de cerdo', 0.130),
    ('Porción de proteína - lomo de cerdo', 'Lomo de cerdo', 0.130),
    ('Menú ejecutivo - pechuga', 'Pechuga de pollo', 0.130),
    ('Porción de proteína - pechuga', 'Pechuga de pollo', 0.130),
    ('menú ejecutvo - pollo pernil', 'Pierna pernil de pollo', 0.400),
    ('Porción de proteína - pierna pernil', 'Pierna pernil de pollo', 0.400),
    ('Porción de proteína - filete de pescado', 'Filete de pescado', 0.130),
    ('Churrasco', 'Lomo de res', 0.400),
    ('Pechuga a la plancha', 'Pechuga de pollo', 0.400),
    ('Pechuga en salsa bourguinon', 'Pechuga de pollo', 0.400),
    ('Pechuga en salsa de champiñones', 'Pechuga de pollo', 0.400),
    ('Pechuga hawaiana', 'Pechuga de pollo', 0.400),
    ('Pollo a la grille', 'Pechuga de pollo', 0.400),
    ('Cerdo a la milanesa', 'Lomo de cerdo', 0.400),
    ('Lomo de cerdo a la plancha', 'Lomo de cerdo', 0.400),
    ('Lomo de cerdo hawaiano', 'Lomo de cerdo', 0.400),
    ('Churrasquito / especial', 'Lomo de res', 0.200),
    ('Pechuga grille / especial', 'Pechuga de pollo', 0.200),
    ('Trucha a la plancha / especial', 'Trucha', 0.300),
    ('Mojarra frita - Especial', 'Mojarra', 0.300),
    ('Bagre a la criolla', 'Bagre', 0.500),
    ('Filete de mojarra a la plancha', 'Mojarra', 0.500),
    ('Filete de mojarra en champiñones', 'Mojarra', 0.500),
    ('Mojarra carta', 'Mojarra', 0.500),
    ('Filete de mojarra a la marinera', 'Mojarra', 0.500),
    ('Filete de mojarra a la marinera', 'Mixtura de mariscos', 0.150),
    ('Trucha a la marinera', 'Trucha', 0.500),
    ('Trucha a la marinera', 'Mixtura de mariscos', 0.150),
    ('Trucha al ajillo', 'Trucha', 0.500),
    ('Viudo de bocachico', 'Bocachico', 0.500),
    ('Cazuela de mariscos', 'Mixtura de mariscos', 0.400),
    ('Tabla mixta al barril', 'Lomo de res', 0.130),
    ('Tabla mixta al barril', 'Lomo de cerdo', 0.130),
    ('Tabla mixta al barril', 'Pechuga de pollo', 0.130),
    ('Picada al barril', 'Lomo de res', 0.130),
    ('Picada al barril', 'Lomo de cerdo', 0.130),
    ('Picada al barril', 'Pechuga de pollo', 0.130),
    ('Picada al barril', 'Chorizo', 1),
    ('Huevo adicional', 'Huevo', 1),
    ('Huevo x sopa', 'Huevo', 1);

  -- 2. Resolución EXACTA de productos: cada nombre debe dar una y solo una fila viva y activa
  select string_agg(pn, '; ') into v_missing
  from (select distinct product_name pn from _fm_bom) b
  where (select count(*) from public.products p
          where p.tenant_id = v_tenant and p.name = b.pn and p.deleted_at is null and p.is_active) = 0;
  if v_missing is not null then
    raise exception 'Guarda: productos no encontrados (nombre exacto, vivos y activos): %', v_missing;
  end if;

  select string_agg(pn, '; ') into v_dup
  from (select distinct product_name pn from _fm_bom) b
  where (select count(*) from public.products p
          where p.tenant_id = v_tenant and p.name = b.pn and p.deleted_at is null and p.is_active) > 1;
  if v_dup is not null then
    raise exception 'Guarda: nombres ambiguos (más de una fila): %', v_dup;
  end if;

  select string_agg(p.name, '; ') into v_var
  from public.products p
  where p.tenant_id = v_tenant and p.deleted_at is null and p.is_active and p.has_variants
    and p.name in (select product_name from _fm_bom);
  if v_var is not null then
    raise exception 'Guarda: productos con variantes (no admiten ficha técnica): %', v_var;
  end if;

  -- Informativo: productos que van a recipe y están en cuentas abiertas
  select count(*), count(distinct ci.cart_id) into v_open_cart_items, v_open_carts
  from public.cart_items ci
  join public.carts c on c.id = ci.cart_id and c.status = 'open' and c.tenant_id = v_tenant
  join public.products p on p.id = ci.product_id and p.tenant_id = v_tenant
  where p.name in (select product_name from _fm_bom) and p.deleted_at is null and p.is_active;
  raise notice 'Barriles: % líneas en % cuentas abiertas contienen productos que pasan a recipe (sus reservas de producto se liberan; las de insumos aparecen en la siguiente edición de la cuenta).',
    v_open_cart_items, v_open_carts;

  -- 3. Módulo `materials` habilitado (manual: el sync del plan no lo toca)
  insert into public.tenant_enabled_modules (tenant_id, module_key, source)
  values (v_tenant, 'materials', 'manual')
  on conflict (tenant_id, module_key) do nothing;

  -- 4. Insumos (idempotente por lower(name); un insumo vivo existente con otra unidad aborta)
  select string_agg(m.name, '; ') into v_bad
  from _fm_materials fm
  join public.materials m on m.tenant_id = v_tenant and lower(m.name) = lower(fm.name) and m.deleted_at is null
  where m.unit <> fm.unit;
  if v_bad is not null then
    raise exception 'Guarda: insumos ya existentes con otra unidad: %', v_bad;
  end if;

  insert into public.materials (tenant_id, name, unit, cost, min_stock, is_active)
  select v_tenant, fm.name, fm.unit, 0, null, true
  from _fm_materials fm
  where not exists (
    select 1 from public.materials m
    where m.tenant_id = v_tenant and lower(m.name) = lower(fm.name) and m.deleted_at is null
  );

  -- 5. Fichas técnicas (product_bom)
  insert into public.product_bom (tenant_id, product_id, material_id, quantity)
  select v_tenant, p.id, m.id, b.qty
  from _fm_bom b
  join public.products p on p.tenant_id = v_tenant and p.name = b.product_name and p.deleted_at is null and p.is_active
  join public.materials m on m.tenant_id = v_tenant and lower(m.name) = lower(b.material_name) and m.deleted_at is null
  on conflict (product_id, material_id) do nothing;

  -- 6. Modo recipe (el trigger fuerza track_inventory = true y libera reservas de stock propio)
  update public.products p
  set inventory_mode = 'recipe'
  where p.tenant_id = v_tenant and p.deleted_at is null and p.is_active
    and p.name in (select product_name from _fm_bom)
    and p.inventory_mode <> 'recipe';

  -- 7. Aserciones
  select count(*) into v_mats from public.materials
   where tenant_id = v_tenant and deleted_at is null and lower(name) in (select lower(name) from _fm_materials);
  if v_mats <> 12 then raise exception 'Aserción: % insumos (esperados 12).', v_mats; end if;

  select count(*) into v_boms
  from _fm_bom b
  join public.products p on p.tenant_id = v_tenant and p.name = b.product_name and p.deleted_at is null and p.is_active
  join public.materials m on m.tenant_id = v_tenant and lower(m.name) = lower(b.material_name) and m.deleted_at is null
  join public.product_bom pb on pb.product_id = p.id and pb.material_id = m.id and pb.tenant_id = v_tenant
                            and pb.quantity = b.qty;
  if v_boms <> 42 then raise exception 'Aserción: % fichas con la cantidad esperada (esperadas 42).', v_boms; end if;

  select count(*) into v_recipes from public.products
   where tenant_id = v_tenant and inventory_mode = 'recipe' and track_inventory and deleted_at is null;
  if v_recipes <> 35 then raise exception 'Aserción: % productos en recipe con track_inventory (esperados 35).', v_recipes; end if;

  if exists (select 1 from public.product_bom pb join public.products p on p.id = pb.product_id
              where pb.tenant_id = v_tenant and p.tenant_id <> v_tenant) then
    raise exception 'Aserción: ficha cruzada entre tenants.';
  end if;
  if exists (select 1 from public.product_bom pb join public.materials m on m.id = pb.material_id
              where pb.tenant_id = v_tenant and m.tenant_id <> v_tenant) then
    raise exception 'Aserción: insumo de otro tenant en una ficha.';
  end if;
  if not exists (select 1 from public.tenant_enabled_modules where tenant_id = v_tenant and module_key = 'materials') then
    raise exception 'Aserción: módulo materials no habilitado.';
  end if;

  raise notice 'Barriles: % insumos, % fichas, % productos en recipe, módulo materials habilitado.', v_mats, v_boms, v_recipes;
end $$;
