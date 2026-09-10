-- get_advisors marcó departments/cities como ERROR ("RLS Disabled in
-- Public", 0013) apenas después de crearlas -- el revoke/grant de la
-- migración anterior (20260909240000) no alcanza, hace falta RLS
-- habilitado con una policy abierta, mismo patrón exacto que ya usan
-- tax_types/document_types (los otros dos catálogos públicos de solo
-- lectura de esta plataforma, confirmado contra sus policies reales antes
-- de escribir esto).
alter table public.departments enable row level security;
alter table public.cities enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'departments' and policyname = 'departments_select') then
    create policy departments_select on public.departments for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'cities' and policyname = 'cities_select') then
    create policy cities_select on public.cities for select using (true);
  end if;
end $$;
