-- ERP: esquema paralelo sin prefijo "crm_", Fase 0 (modelado, sin cutover).
-- Ver 20260815010001_core_contacts.sql para el contexto completo.
-- 1:1 con crm_tasks.

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  assigned_to uuid references public.profiles(id) on delete set null,
  title text not null,
  description text,
  priority text not null default 'media' check (priority in ('baja', 'media', 'alta')),
  status text not null default 'pendiente' check (status in ('pendiente', 'en_proceso', 'completada', 'cancelada')),
  due_date timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index tasks_tenant_id_idx on public.tasks(tenant_id);
create index tasks_contact_id_idx on public.tasks(contact_id);
create index tasks_opportunity_id_idx on public.tasks(opportunity_id);
create index tasks_assigned_to_idx on public.tasks(assigned_to);

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

alter table public.tasks enable row level security;

create policy tasks_select on public.tasks
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy tasks_insert on public.tasks
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy tasks_update on public.tasks
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy tasks_delete on public.tasks
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.tasks from anon;
