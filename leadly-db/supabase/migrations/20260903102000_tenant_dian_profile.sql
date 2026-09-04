-- Perfil legal DIAN del tenant para facturación electrónica directa (cada
-- tenant es su propio facturador, no Leadly -- ver decisión de negocio en
-- CLAUDE.md). Tabla nueva, no se agranda `tenants`: es un dato opcional,
-- específico de facturación, con su propio ciclo de vida (vencimiento de
-- resolución, agotamiento de numeración) -- mismo criterio que
-- tenant_payment_credentials, no se mezcla en el formulario general de
-- perfil de empresa.
create table public.tenant_dian_profile (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  tax_enabled boolean not null default false,
  fiscal_regime text check (fiscal_regime in ('responsable_iva', 'no_responsable_iva')),
  is_self_withholding_agent boolean not null default false,
  city text,
  resolution_number text,
  resolution_prefix text,
  resolution_range_from bigint,
  resolution_range_to bigint,
  resolution_valid_from date,
  resolution_valid_until date,
  next_invoice_number bigint,
  software_id text,
  is_configured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

comment on column public.tenant_dian_profile.tax_enabled is 'Interruptor central: mientras esté en false, el cálculo de impuestos no se activa en ningún pedido nuevo de este tenant -- nada cambia en lo que se cobra hasta que el tenant lo prenda a propósito.';
comment on column public.tenant_dian_profile.is_self_withholding_agent is 'Si el tenant mismo es autorretenedor (código de responsabilidad 15 en su RUT) -- informativo en esta fase, la lógica de autorretención sobre las propias ventas es una fase posterior.';

create trigger tenant_dian_profile_set_updated_at
  before update on public.tenant_dian_profile
  for each row execute function public.set_updated_at();

alter table public.tenant_dian_profile enable row level security;

create policy tenant_dian_profile_select on public.tenant_dian_profile
  for select to authenticated using (public.is_superadmin() or tenant_id = public.auth_active_tenant_id());
create policy tenant_dian_profile_tenant_admin_write on public.tenant_dian_profile
  for all to authenticated
  using (public.is_tenant_admin() and tenant_id = public.auth_active_tenant_id())
  with check (public.is_tenant_admin() and tenant_id = public.auth_active_tenant_id());
create policy tenant_dian_profile_superadmin_write on public.tenant_dian_profile
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

revoke all on public.tenant_dian_profile from anon;
