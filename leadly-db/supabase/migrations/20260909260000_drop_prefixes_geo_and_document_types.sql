-- Pedido explícito del usuario 2026-09-09: "no debe hacer una tabla de dian
-- document Types son los tipos de documentos en nuestra db, quitale ese
-- prefijo, lo mismo en los departamentos ciudades... porque pones
-- co_cities, es cities y se filtran por departamento y ciudad" -- mismo
-- criterio de convención del proyecto ya aplicado en 2026-08-15 al esquema
-- completo (crm_* -> sin prefijo): estas tres tablas nacieron con un
-- prefijo (dian_/co_) que no aporta nada -- son catálogos propios de esta
-- base, no de un sistema externo llamado "dian" o "co". Renombrar una tabla
-- no rompe sus FKs (Postgres las sigue por oid, no por nombre) -- solo
-- índices y policies, creados con el nombre viejo, se renombran acá para
-- que no quede un rastro del prefijo tampoco ahí.
--
-- Reescrita con guards 2026-09-10 (reconciliación de migraciones nunca
-- aplicadas como archivo, ver 20260909230000): `dian_document_types` ya
-- había sido renombrada a `document_types` por fuera de este archivo -- el
-- rename de esa tabla queda protegido para no fallar si ya corrió.
do $$
begin
  if to_regclass('public.dian_document_types') is not null then
    alter table public.dian_document_types rename to document_types;
    alter index public.dian_document_types_pkey rename to document_types_pkey;
    alter policy dian_document_types_select on public.document_types rename to document_types_select;
  end if;
end $$;

do $$
begin
  if to_regclass('public.co_departments') is not null then
    alter table public.co_departments rename to departments;
    alter index public.co_departments_pkey rename to departments_pkey;
    alter policy co_departments_select on public.departments rename to departments_select;
  end if;
end $$;

do $$
begin
  if to_regclass('public.co_cities') is not null then
    alter table public.co_cities rename to cities;
    alter index public.co_cities_pkey rename to cities_pkey;
    alter index public.co_cities_department_code_idx rename to cities_department_code_idx;
    alter policy co_cities_select on public.cities rename to cities_select;
    alter table public.cities rename constraint co_cities_department_code_fkey to cities_department_code_fkey;
  end if;
end $$;
