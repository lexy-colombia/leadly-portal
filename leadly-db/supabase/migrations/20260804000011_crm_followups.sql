-- Seguimientos: a lightweight internal follow-up task on a CRM contact
-- ("recordarme escribirle el 10/08 sobre la cotización"), separate from
-- crm_appointments on purpose -- an appointment is a scheduled meeting with
-- the contact that triggers a WhatsApp reminder to them; a follow-up is
-- just a due date + note for the agent, no WhatsApp side effects.
create table public.crm_followups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  due_at timestamptz not null,
  note text,
  status text not null default 'pendiente' check (status in ('pendiente', 'completado')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index crm_followups_contact_id_idx on public.crm_followups(contact_id);

create trigger crm_followups_set_updated_at
  before update on public.crm_followups
  for each row execute function public.set_updated_at();

alter table public.crm_followups enable row level security;

create policy crm_followups_select on public.crm_followups
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_followups_insert on public.crm_followups
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_followups_update on public.crm_followups
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_followups from anon;
