-- Barriles de la sexta: corrección de categorías mal asignadas (pedido
-- explícito del usuario, 2026-10-06, a raíz de comparar el catálogo con el
-- menú impreso). Solo toca `product_category_links` de ESTE tenant; no cambia
-- precios, visibilidad ni ninguna otra columna.
--
-- 1. Sin categoría (13): los "- Ejecutivo" / "Menú ejecutivo -" van a
--    "Menú Ejecutivo"; las 5 "Porción de proteína -" a "Porciones".
-- 2. En "Pescados" por error: "Pechuga  plancha - ejecutivo" (es un menú
--    ejecutivo de pollo, inactivo) -> "Menú Ejecutivo".
-- 3. En "Decoraciones" por error: "Menú 2 carnes" -> "Menú Ejecutivo";
--    "Servicio de restaurante" (la línea genérica de la migración de Fudo, no
--    un plato) queda SIN categoría -- no hay una categoría que le corresponda
--    y no se crea una nueva sin pedirla.
--
-- Cada paso verifica cuántos productos encontró y aborta si no son los
-- esperados: un nombre mal escrito no debe fallar en silencio.

do $$
declare
  v_tenant constant uuid := '9c79437d-1c19-4edc-bc1f-0dc06094823a';
  v_ejecutivo uuid;
  v_porciones uuid;
  v_pescados uuid;
  v_decoraciones uuid;
  v_found int;
begin
  select id into v_ejecutivo from public.product_categories where tenant_id = v_tenant and name = 'Menú Ejecutivo' and deleted_at is null;
  select id into v_porciones from public.product_categories where tenant_id = v_tenant and name = 'Porciones' and deleted_at is null;
  select id into v_pescados from public.product_categories where tenant_id = v_tenant and name = 'Pescados' and deleted_at is null;
  select id into v_decoraciones from public.product_categories where tenant_id = v_tenant and name = 'Decoraciones' and deleted_at is null;
  if v_ejecutivo is null or v_porciones is null or v_pescados is null or v_decoraciones is null then
    raise exception 'Faltan categorías esperadas del tenant Barriles de la sexta';
  end if;

  -- 1a. Ejecutivos sin categoría -> Menú Ejecutivo
  with target as (
    select p.id from public.products p
    where p.tenant_id = v_tenant and p.deleted_at is null
      and p.name in (
        'Carne Goulash - Ejecutivo', 'Costilla bbq - Ejecutivo', 'Filete de mojarra - Ejecutivo',
        'Frijolada - Ejecutivo', 'Menú ejecutivo - Lengua alcaparrada', 'Menú ejecutivo - Ropa vieja',
        'Panceta de cerdo - Ejecutivo', 'Ragú de cerdo - Ejecutivo'
      )
      and not exists (select 1 from public.product_category_links l where l.product_id = p.id)
  ), ins as (
    insert into public.product_category_links (product_id, category_id, tenant_id)
    select id, v_ejecutivo, v_tenant from target
    on conflict do nothing
    returning 1
  )
  select count(*) into v_found from ins;
  if v_found <> 8 then raise exception 'Ejecutivos sin categoría: se esperaban 8 y se movieron %', v_found; end if;

  -- 1b. Porciones de proteína sin categoría -> Porciones
  with target as (
    select p.id from public.products p
    where p.tenant_id = v_tenant and p.deleted_at is null
      and p.name like 'Porción de proteína - %'
      and not exists (select 1 from public.product_category_links l where l.product_id = p.id)
  ), ins as (
    insert into public.product_category_links (product_id, category_id, tenant_id)
    select id, v_porciones, v_tenant from target
    on conflict do nothing
    returning 1
  )
  select count(*) into v_found from ins;
  if v_found <> 5 then raise exception 'Porciones de proteína: se esperaban 5 y se movieron %', v_found; end if;

  -- 2. "Pechuga  plancha - ejecutivo": Pescados -> Menú Ejecutivo
  with moved as (
    update public.product_category_links l
    set category_id = v_ejecutivo
    from public.products p
    where l.product_id = p.id and p.tenant_id = v_tenant and p.deleted_at is null
      and p.name = 'Pechuga  plancha - ejecutivo' and l.category_id = v_pescados
    returning 1
  )
  select count(*) into v_found from moved;
  if v_found <> 1 then raise exception 'Pechuga plancha ejecutivo: se esperaba 1 y se movió %', v_found; end if;

  -- 3a. "Menú 2 carnes": Decoraciones -> Menú Ejecutivo
  with moved as (
    update public.product_category_links l
    set category_id = v_ejecutivo
    from public.products p
    where l.product_id = p.id and p.tenant_id = v_tenant and p.deleted_at is null
      and p.name = 'Menú 2 carnes' and l.category_id = v_decoraciones
    returning 1
  )
  select count(*) into v_found from moved;
  if v_found <> 1 then raise exception 'Menú 2 carnes: se esperaba 1 y se movió %', v_found; end if;

  -- 3b. "Servicio de restaurante": fuera de Decoraciones, sin categoría
  with removed as (
    delete from public.product_category_links l
    using public.products p
    where l.product_id = p.id and p.tenant_id = v_tenant and p.deleted_at is null
      and p.name = 'Servicio de restaurante' and l.category_id = v_decoraciones
    returning 1
  )
  select count(*) into v_found from removed;
  if v_found <> 1 then raise exception 'Servicio de restaurante: se esperaba 1 y se quitó %', v_found; end if;
end;
$$;
