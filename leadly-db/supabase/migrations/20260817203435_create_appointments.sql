-- `appointments` nunca tuvo una fase 0 paralela (a diferencia de notes/
-- contact_addresses, que sí se modelaron sin prefijo desde el 15-08) --
-- crm_appointments se dropeó el 17-08 sin ningún destino nuevo, dejando
-- Calendario y send-appointment-reminders rotos. Recreada 1:1 contra el
-- shape original (20260804000003_crm_appointments.sql), solo repunteando
-- contact_id a clients (mismo nombre de columna que notes/contact_addresses/
-- tasks/opportunities ya usan para lo mismo, no client_id).

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.clients(id) on delete cascade,
  whatsapp_line_id uuid references public.whatsapp_lines(id) on delete set null,
  scheduled_at timestamptz not null,
  notes text,
  status text not null default 'activa' check (status in ('activa', 'completada', 'cancelada')),
  created_by uuid references public.profiles(id) on delete set null,
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index appointments_contact_id_idx on public.appointments(contact_id);
create index appointments_reminder_scan_idx on public.appointments(scheduled_at) where status = 'activa' and reminder_sent_at is null;

create trigger appointments_set_updated_at
  before update on public.appointments
  for each row execute function public.set_updated_at();

alter table public.appointments enable row level security;

create policy appointments_select on public.appointments
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy appointments_insert on public.appointments
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy appointments_update on public.appointments
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.appointments from anon;
