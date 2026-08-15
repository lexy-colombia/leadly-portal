-- ERP: esquema paralelo sin prefijo "crm_", Fase 0 (modelado, sin cutover).
-- Ver 20260815010001_core_contacts.sql para el contexto completo.
--
-- 1:1 con crm_pqrs/crm_pqr_updates/crm_attachments. Va al final del bloque
-- de migraciones porque attachments referencia tasks y sales_order_comments
-- (creadas en 20260815010004/010005).

create table public.pqrs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  type text not null check (type in ('peticion', 'queja', 'reclamo')),
  subject text not null,
  description text,
  status text not null default 'abierto' check (status in ('abierto', 'en_proceso', 'resuelto', 'cerrado')),
  code integer not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_by_ai boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index pqrs_contact_id_idx on public.pqrs(contact_id);
create unique index pqrs_tenant_id_code_idx on public.pqrs(tenant_id, code);

create trigger pqrs_set_updated_at
  before update on public.pqrs
  for each row execute function public.set_updated_at();

alter table public.pqrs enable row level security;

create policy pqrs_select on public.pqrs
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy pqrs_insert on public.pqrs
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy pqrs_update on public.pqrs
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.pqrs from anon;

create or replace function public.set_pqr_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select coalesce(max(code), 0) + 1 into new.code
    from public.pqrs where tenant_id = new.tenant_id;
  return new;
end;
$$;

create trigger trg_pqrs_set_code
  before insert on public.pqrs
  for each row execute function public.set_pqr_code();

create table public.pqr_updates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pqr_id uuid not null references public.pqrs(id) on delete cascade,
  content text not null,
  seq integer not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_by_ai boolean not null default false,
  created_at timestamptz not null default now()
);

create index pqr_updates_pqr_id_idx on public.pqr_updates(pqr_id);
create unique index pqr_updates_pqr_id_seq_idx on public.pqr_updates(pqr_id, seq);

alter table public.pqr_updates enable row level security;

create policy pqr_updates_select on public.pqr_updates
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy pqr_updates_insert on public.pqr_updates
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.pqr_updates from anon;

create or replace function public.set_pqr_update_seq()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select coalesce(max(seq), 0) + 1 into new.seq
    from public.pqr_updates where pqr_id = new.pqr_id;
  return new;
end;
$$;

create trigger trg_pqr_updates_set_seq
  before insert on public.pqr_updates
  for each row execute function public.set_pqr_update_seq();

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pqr_id uuid references public.pqrs(id) on delete cascade,
  pqr_update_id uuid references public.pqr_updates(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  sales_order_comment_id uuid references public.sales_order_comments(id) on delete cascade,
  storage_path text not null,
  mime_type text not null check (mime_type like 'image/%' or mime_type = 'application/pdf'),
  size_bytes integer not null,
  original_filename text,
  created_by uuid references public.profiles(id) on delete set null,
  created_by_ai boolean not null default false,
  created_at timestamptz not null default now(),
  constraint attachments_exactly_one_parent check (
    (case when pqr_id is not null then 1 else 0 end)
    + (case when pqr_update_id is not null then 1 else 0 end)
    + (case when task_id is not null then 1 else 0 end)
    + (case when sales_order_comment_id is not null then 1 else 0 end) = 1
  )
);

create index attachments_pqr_id_idx on public.attachments(pqr_id);
create index attachments_pqr_update_id_idx on public.attachments(pqr_update_id);
create index attachments_task_id_idx on public.attachments(task_id);
create index attachments_sales_order_comment_id_idx on public.attachments(sales_order_comment_id);

alter table public.attachments enable row level security;

create policy attachments_select on public.attachments
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy attachments_insert on public.attachments
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.attachments from anon;
