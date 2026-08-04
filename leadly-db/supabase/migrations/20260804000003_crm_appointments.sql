-- Appointments/agendamientos on a CRM contact -- separate from crm_notes
-- (a note is a free-form log entry; an appointment has a specific
-- scheduled_at the reminder cron below acts on). whatsapp_line_id is
-- nullable and only used to know which line's token to send the WhatsApp
-- reminder through -- set at creation time from the contact's most recent
-- conversation, not user-picked.
create table public.crm_appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  whatsapp_line_id uuid references public.whatsapp_lines(id) on delete set null,
  scheduled_at timestamptz not null,
  notes text,
  status text not null default 'activa' check (status in ('activa', 'completada', 'cancelada')),
  created_by uuid references public.profiles(id) on delete set null,
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index crm_appointments_contact_id_idx on public.crm_appointments(contact_id);
-- Used by the reminder cron's scan window (status + scheduled_at + not yet reminded).
create index crm_appointments_reminder_scan_idx on public.crm_appointments(scheduled_at) where status = 'activa' and reminder_sent_at is null;

create trigger crm_appointments_set_updated_at
  before update on public.crm_appointments
  for each row execute function public.set_updated_at();

alter table public.crm_appointments enable row level security;

create policy crm_appointments_select on public.crm_appointments
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_appointments_insert on public.crm_appointments
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_appointments_update on public.crm_appointments
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_appointments from anon;
