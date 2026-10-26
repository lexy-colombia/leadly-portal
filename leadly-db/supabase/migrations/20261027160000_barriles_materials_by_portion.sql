-- Barriles de la sexta: corrección de insumos y fichas -> insumos por PORCIÓN (unidad 'un').
-- Brief: progress/brief_barriles_fichas_v2.md. Corrige 20261027150000 (ya aplicada), que cargó 10 insumos en kg:
-- el cliente compra todo ya porcionado, así que cada insumo es una porción de un gramaje concreto.
--
-- Qué hace (todo acotado al tenant fijo, guardas que ABORTAN si algo no cuadra):
--   1. Guarda de tenant (id + nombre) y guarda DURA: aborta si hay filas en material_stock, material_movements
--      o material_reservations de los insumos involucrados (no se rehacen datos a ciegas).
--   2. Borra y recrea las fichas (product_bom) de los 35 productos (siguen en inventory_mode = 'recipe').
--   3. Retira los 10 insumos viejos en kg por SOFT-DELETE (deleted_at). Se prefiere sobre DELETE real porque
--      `materials` es tabla de negocio (convención del proyecto) y conserva el rastro de qué insumos existieron;
--      las FKs (cascade en product_bom/material_stock/reservations, restrict en material_movements) permitirían
--      el delete real porque la guarda garantiza que no hay filas, pero no aporta nada y se pierde la historia.
--      El índice único (tenant_id, lower(name)) es PARCIAL (where deleted_at is null), así que un soft-delete
--      libera el nombre y no choca con los nuevos. "Chorizo" y "Huevo" (ya en 'un', costo 0) NO se retiran: son
--      idénticos a los nuevos, se reutilizan en lugar de borrar y recrear con otro id.
--   4. Crea los 18 insumos nuevos que faltan (Chorizo y Huevo ya existen): 'un', costo 0, min_stock null, activos.
--   5. Recrea las 42 filas de ficha y verifica con aserciones.
-- Idempotente: una segunda corrida no encuentra insumos en kg, reutiliza los 20 y recrea las mismas fichas.
-- Efecto operativo: las cuentas POS abiertas con productos recipe guardan reservas de insumos
-- (material_reservations) al editarse. Esta migración NO las toca: si existen para los insumos del tenant la
-- guarda dura aborta y hay que cerrar/cancelar esas cuentas (o dejar que expiren) antes de reintentar.
-- Una cuenta abierta cuyas líneas ya estaban en recipe pero que no se editó desde 20261027150000 no tiene reservas.

do $$
declare
  v_tenant constant uuid := '9c79437d-1c19-4edc-bc1f-0dc06094823a';
  v_name text;
  v_bad text;
  v_dup text;
  v_missing text;
  v_var text;
  v_mats int;
  v_boms int;
  v_recipes int;
  v_old int;
begin
  -- 1. Guarda de tenant
  select name into v_name from public.tenants where id = v_tenant;
  if v_name is distinct from 'Barriles de la sexta' then
    raise exception 'Guarda: el tenant % no es Barriles de la sexta (%).', v_tenant, v_name;
  end if;

  create temporary table _fp_old (name text primary key) on commit drop;
  insert into _fp_old values
    ('Lomo de res'), ('Lomo de cerdo'), ('Pechuga de pollo'), ('Pierna pernil de pollo'), ('Filete de pescado'),
    ('Trucha'), ('Mojarra'), ('Bagre'), ('Bocachico'), ('Mixtura de mariscos');

  create temporary table _fp_materials (name text primary key) on commit drop;
  insert into _fp_materials values
    ('Lomo de res 130 g'), ('Lomo de res 200 g'), ('Lomo de res 400 g'), ('Lomo de cerdo 130 g'), ('Lomo de cerdo 400 g'),
    ('Pechuga de pollo 130 g'), ('Pechuga de pollo 200 g'), ('Pechuga de pollo 400 g'), ('Pierna pernil de pollo 400 g'),
    ('Filete de pescado 130 g'), ('Trucha 300 g'), ('Trucha 500 g'), ('Mojarra 300 g'), ('Mojarra 500 g'),
    ('Bagre 500 g'), ('Bocachico 500 g'), ('Mixtura de mariscos 150 g'), ('Mixtura de mariscos 400 g'),
    ('Chorizo'), ('Huevo');

  create temporary table _fp_bom (product_name text not null, material_name text not null, qty numeric(14,4) not null,
                                  primary key (product_name, material_name)) on commit drop;
  insert into _fp_bom values
    ('Menú ejecutivo - lomo de res', 'Lomo de res 130 g', 1),
    ('Porción de proteína - lomo de res', 'Lomo de res 130 g', 1),
    ('Menú ejecutivo - lomo de cerdo', 'Lomo de cerdo 130 g', 1),
    ('Porción de proteína - lomo de cerdo', 'Lomo de cerdo 130 g', 1),
    ('Menú ejecutivo - pechuga', 'Pechuga de pollo 130 g', 1),
    ('Porción de proteína - pechuga', 'Pechuga de pollo 130 g', 1),
    ('menú ejecutvo - pollo pernil', 'Pierna pernil de pollo 400 g', 1),
    ('Porción de proteína - pierna pernil', 'Pierna pernil de pollo 400 g', 1),
    ('Porción de proteína - filete de pescado', 'Filete de pescado 130 g', 1),
    ('Churrasco', 'Lomo de res 400 g', 1),
    ('Pechuga a la plancha', 'Pechuga de pollo 400 g', 1),
    ('Pechuga en salsa bourguinon', 'Pechuga de pollo 400 g', 1),
    ('Pechuga en salsa de champiñones', 'Pechuga de pollo 400 g', 1),
    ('Pechuga hawaiana', 'Pechuga de pollo 400 g', 1),
    ('Pollo a la grille', 'Pechuga de pollo 400 g', 1),
    ('Cerdo a la milanesa', 'Lomo de cerdo 400 g', 1),
    ('Lomo de cerdo a la plancha', 'Lomo de cerdo 400 g', 1),
    ('Lomo de cerdo hawaiano', 'Lomo de cerdo 400 g', 1),
    ('Churrasquito / especial', 'Lomo de res 200 g', 1),
    ('Pechuga grille / especial', 'Pechuga de pollo 200 g', 1),
    ('Trucha a la plancha / especial', 'Trucha 300 g', 1),
    ('Mojarra frita - Especial', 'Mojarra 300 g', 1),
    ('Bagre a la criolla', 'Bagre 500 g', 1),
    ('Filete de mojarra a la plancha', 'Mojarra 500 g', 1),
    ('Filete de mojarra en champiñones', 'Mojarra 500 g', 1),
    ('Mojarra carta', 'Mojarra 500 g', 1),
    ('Filete de mojarra a la marinera', 'Mojarra 500 g', 1),
    ('Filete de mojarra a la marinera', 'Mixtura de mariscos 150 g', 1),
    ('Trucha a la marinera', 'Trucha 500 g', 1),
    ('Trucha a la marinera', 'Mixtura de mariscos 150 g', 1),
    ('Trucha al ajillo', 'Trucha 500 g', 1),
    ('Viudo de bocachico', 'Bocachico 500 g', 1),
    ('Cazuela de mariscos', 'Mixtura de mariscos 400 g', 1),
    ('Tabla mixta al barril', 'Lomo de res 130 g', 1),
    ('Tabla mixta al barril', 'Lomo de cerdo 130 g', 1),
    ('Tabla mixta al barril', 'Pechuga de pollo 130 g', 1),
    ('Picada al barril', 'Lomo de res 130 g', 1),
    ('Picada al barril', 'Lomo de cerdo 130 g', 1),
    ('Picada al barril', 'Pechuga de pollo 130 g', 1),
    ('Picada al barril', 'Chorizo', 1),
    ('Huevo adicional', 'Huevo', 1),
    ('Huevo x sopa', 'Huevo', 1);

  -- 2. Productos: nombre exacto, uno solo, vivo y activo, sin variantes
  select string_agg(pn, '; ') into v_missing
  from (select distinct product_name pn from _fp_bom) b
  where (select count(*) from public.products p
          where p.tenant_id = v_tenant and p.name = b.pn and p.deleted_at is null and p.is_active) = 0;
  if v_missing is not null then
    raise exception 'Guarda: productos no encontrados (nombre exacto, vivos y activos): %', v_missing;
  end if;

  select string_agg(pn, '; ') into v_dup
  from (select distinct product_name pn from _fp_bom) b
  where (select count(*) from public.products p
          where p.tenant_id = v_tenant and p.name = b.pn and p.deleted_at is null and p.is_active) > 1;
  if v_dup is not null then
    raise exception 'Guarda: nombres ambiguos (más de una fila): %', v_dup;
  end if;

  select string_agg(p.name, '; ') into v_var
  from public.products p
  where p.tenant_id = v_tenant and p.deleted_at is null and p.is_active and p.has_variants
    and p.name in (select product_name from _fp_bom);
  if v_var is not null then
    raise exception 'Guarda: productos con variantes (no admiten ficha técnica): %', v_var;
  end if;

  -- 3. Insumos existentes: los viejos deben estar en kg; los nuevos (si ya existen) en 'un'
  select string_agg(m.name || ' (' || m.unit || ')', '; ') into v_bad
  from public.materials m
  where m.tenant_id = v_tenant and m.deleted_at is null
    and ((lower(m.name) in (select lower(name) from _fp_old) and m.unit <> 'kg')
      or (lower(m.name) in (select lower(name) from _fp_materials) and m.unit <> 'un'));
  if v_bad is not null then
    raise exception 'Guarda: insumos existentes con unidad inesperada (viejos deben ser kg, nuevos un): %', v_bad;
  end if;

  -- 4. Guarda DURA: sin existencias, movimientos ni reservas de los insumos involucrados
  if exists (
    select 1 from public.material_stock s join public.materials m on m.id = s.material_id
     where m.tenant_id = v_tenant and m.deleted_at is null
       and lower(m.name) in (select lower(name) from _fp_old union select lower(name) from _fp_materials)
  ) then
    raise exception 'Guarda: hay filas en material_stock de los insumos de Barriles; no se rehacen a ciegas.';
  end if;
  if exists (
    select 1 from public.material_movements mm join public.materials m on m.id = mm.material_id
     where m.tenant_id = v_tenant and m.deleted_at is null
       and lower(m.name) in (select lower(name) from _fp_old union select lower(name) from _fp_materials)
  ) then
    raise exception 'Guarda: hay filas en material_movements de los insumos de Barriles; no se rehacen a ciegas.';
  end if;
  if exists (
    select 1 from public.material_reservations r join public.materials m on m.id = r.material_id
     where m.tenant_id = v_tenant and m.deleted_at is null
       and lower(m.name) in (select lower(name) from _fp_old union select lower(name) from _fp_materials)
  ) then
    raise exception 'Guarda: hay filas en material_reservations (cuentas abiertas con productos recipe); cierra o cancela esas cuentas y reintenta.';
  end if;

  -- 5. Ninguna ficha de OTROS productos puede depender de un insumo viejo que se va a retirar
  select string_agg(distinct p.name, '; ') into v_bad
  from public.product_bom pb
  join public.materials m on m.id = pb.material_id and m.tenant_id = v_tenant and m.deleted_at is null
                         and lower(m.name) in (select lower(name) from _fp_old)
  join public.products p on p.id = pb.product_id
  where pb.tenant_id = v_tenant and p.name not in (select product_name from _fp_bom);
  if v_bad is not null then
    raise exception 'Guarda: productos fuera de la lista usan insumos viejos: %', v_bad;
  end if;

  -- 6. Borra las fichas de los 35 productos (lista de configuración: borrado real, como el resto de product_bom)
  delete from public.product_bom pb
  using public.products p
  where pb.product_id = p.id and pb.tenant_id = v_tenant and p.tenant_id = v_tenant
    and p.deleted_at is null and p.is_active
    and p.name in (select product_name from _fp_bom);

  -- 7. Retira los insumos viejos (kg) por soft-delete
  update public.materials m
  set deleted_at = now()
  where m.tenant_id = v_tenant and m.deleted_at is null and m.unit = 'kg'
    and lower(m.name) in (select lower(name) from _fp_old);

  -- 8. Crea los insumos nuevos que falten (Chorizo y Huevo ya existen y se reutilizan)
  insert into public.materials (tenant_id, name, unit, cost, min_stock, is_active)
  select v_tenant, fm.name, 'un', 0, null, true
  from _fp_materials fm
  where not exists (
    select 1 from public.materials m
    where m.tenant_id = v_tenant and lower(m.name) = lower(fm.name) and m.deleted_at is null
  );

  -- 9. Recrea las fichas
  insert into public.product_bom (tenant_id, product_id, material_id, quantity)
  select v_tenant, p.id, m.id, b.qty
  from _fp_bom b
  join public.products p on p.tenant_id = v_tenant and p.name = b.product_name and p.deleted_at is null and p.is_active
  join public.materials m on m.tenant_id = v_tenant and lower(m.name) = lower(b.material_name) and m.deleted_at is null;

  -- 10. Modo recipe (ya lo estaban; cubre el caso de que alguien lo haya cambiado)
  update public.products p
  set inventory_mode = 'recipe'
  where p.tenant_id = v_tenant and p.deleted_at is null and p.is_active
    and p.name in (select product_name from _fp_bom)
    and p.inventory_mode <> 'recipe';

  -- 11. Aserciones
  select count(*) into v_mats from public.materials
   where tenant_id = v_tenant and deleted_at is null and unit = 'un' and cost = 0 and is_active and min_stock is null
     and lower(name) in (select lower(name) from _fp_materials);
  if v_mats <> 20 then raise exception 'Aserción: % insumos nuevos vivos en unidad un (esperados 20).', v_mats; end if;

  select count(*) into v_old from public.materials
   where tenant_id = v_tenant and deleted_at is null and lower(name) in (select lower(name) from _fp_old);
  if v_old <> 0 then raise exception 'Aserción: quedan % insumos viejos vivos.', v_old; end if;

  select count(*) into v_boms
  from _fp_bom b
  join public.products p on p.tenant_id = v_tenant and p.name = b.product_name and p.deleted_at is null and p.is_active
  join public.materials m on m.tenant_id = v_tenant and lower(m.name) = lower(b.material_name) and m.deleted_at is null
  join public.product_bom pb on pb.product_id = p.id and pb.material_id = m.id and pb.tenant_id = v_tenant
                            and pb.quantity = b.qty;
  if v_boms <> 42 then raise exception 'Aserción: % fichas con la cantidad esperada (esperadas 42).', v_boms; end if;

  if (select count(*) from public.product_bom pb join public.products p on p.id = pb.product_id
       where pb.tenant_id = v_tenant and p.name in (select product_name from _fp_bom)) <> 42 then
    raise exception 'Aserción: hay filas de ficha adicionales a las 42 esperadas.';
  end if;

  select count(*) into v_recipes from public.products
   where tenant_id = v_tenant and inventory_mode = 'recipe' and track_inventory and deleted_at is null;
  if v_recipes <> 35 then raise exception 'Aserción: % productos en recipe con track_inventory (esperados 35).', v_recipes; end if;

  if exists (select 1 from public.product_bom pb join public.products p on p.id = pb.product_id
              where pb.tenant_id = v_tenant and p.tenant_id <> v_tenant) then
    raise exception 'Aserción: ficha cruzada entre tenants.';
  end if;
  if exists (select 1 from public.product_bom pb join public.materials m on m.id = pb.material_id
              where pb.tenant_id = v_tenant and (m.tenant_id <> v_tenant or m.deleted_at is not null or m.unit <> 'un')) then
    raise exception 'Aserción: una ficha apunta a un insumo borrado, de otro tenant o que no está en un.';
  end if;

  raise notice 'Barriles: % insumos por porción, % fichas, % productos en recipe, 0 insumos kg vivos.', v_mats, v_boms, v_recipes;
end $$;
