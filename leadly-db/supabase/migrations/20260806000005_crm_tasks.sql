-- crm_tasks: didn't exist at all before this -- follow-ups/reminders for an
-- agent, optionally tied to a contact and/or an opportunity (both nullable:
-- a task can be general, "just about" a contact, or specific to a deal).
create table public.crm_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid references public.crm_contacts(id) on delete cascade,
  opportunity_id uuid references public.crm_opportunities(id) on delete cascade,
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

create index crm_tasks_tenant_id_idx on public.crm_tasks(tenant_id);
create index crm_tasks_contact_id_idx on public.crm_tasks(contact_id);
create index crm_tasks_opportunity_id_idx on public.crm_tasks(opportunity_id);
create index crm_tasks_assigned_to_idx on public.crm_tasks(assigned_to);

create trigger crm_tasks_set_updated_at
  before update on public.crm_tasks
  for each row execute function public.set_updated_at();

alter table public.crm_tasks enable row level security;

create policy crm_tasks_select on public.crm_tasks
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_tasks_insert on public.crm_tasks
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_tasks_update on public.crm_tasks
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_tasks_delete on public.crm_tasks
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_tasks from anon;
