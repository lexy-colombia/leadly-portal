-- PQR (Petición/Queja/Reclamo) per CRM contact -- a distinct concept from
-- crm_notes (free-form log) and crm_appointments (scheduled meetings with a
-- WhatsApp reminder): a PQR is a formal case with a type and a status
-- workflow that needs to be tracked to resolution.
create table public.crm_pqrs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  type text not null check (type in ('peticion', 'queja', 'reclamo')),
  subject text not null,
  description text,
  status text not null default 'abierto' check (status in ('abierto', 'en_proceso', 'resuelto', 'cerrado')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index crm_pqrs_contact_id_idx on public.crm_pqrs(contact_id);

create trigger crm_pqrs_set_updated_at
  before update on public.crm_pqrs
  for each row execute function public.set_updated_at();

alter table public.crm_pqrs enable row level security;

create policy crm_pqrs_select on public.crm_pqrs
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_pqrs_insert on public.crm_pqrs
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_pqrs_update on public.crm_pqrs
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_pqrs from anon;
