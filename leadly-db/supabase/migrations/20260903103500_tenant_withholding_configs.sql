-- Configuración de tarifas de retención por tenant -- las tarifas dependen
-- del concepto de la operación (compra de bienes vs. servicios, etc.) y
-- cambian con la UVT anual. Se deja como configuración editable por el
-- tenant en vez de hardcodear una tabla de tarifas "oficial" que arriesgue
-- estar desactualizada o mal aplicada en algo de cumplimiento fiscal real.
create table public.tenant_withholding_configs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tax_type_code text not null references public.tax_types(code) check (tax_type_code in ('05', '06', '07')),
  concept text not null,
  rate numeric not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index tenant_withholding_configs_tenant_id_idx on public.tenant_withholding_configs(tenant_id);

create trigger tenant_withholding_configs_set_updated_at
  before update on public.tenant_withholding_configs
  for each row execute function public.set_updated_at();

alter table public.tenant_withholding_configs enable row level security;

create policy tenant_withholding_configs_select on public.tenant_withholding_configs
  for select to authenticated using (public.is_superadmin() or tenant_id = public.auth_active_tenant_id());
create policy tenant_withholding_configs_tenant_admin_write on public.tenant_withholding_configs
  for all to authenticated
  using (public.is_tenant_admin() and tenant_id = public.auth_active_tenant_id())
  with check (public.is_tenant_admin() and tenant_id = public.auth_active_tenant_id());
create policy tenant_withholding_configs_superadmin_write on public.tenant_withholding_configs
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

revoke all on public.tenant_withholding_configs from anon;
