-- CRM contacts: the tenant's own leads/customers, distinct from `tenants`
-- (Leadly's customers). Every WhatsApp conversation gets linked to one, and
-- the contact detail screen is where a tenant builds a real history (notes +
-- every conversation) instead of conversations being disposable/anonymous.

create table public.crm_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  full_name text not null,
  phone text not null,
  email text,
  company text,
  stage text not null default 'lead' check (stage in ('lead', 'contactado', 'negociacion', 'cliente', 'perdido')),
  tags text[] not null default '{}',
  assigned_to uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, phone)
);

create index crm_contacts_tenant_id_idx on public.crm_contacts(tenant_id);

create trigger crm_contacts_set_updated_at
  before update on public.crm_contacts
  for each row execute function public.set_updated_at();

alter table public.crm_contacts enable row level security;

create policy crm_contacts_select on public.crm_contacts
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_contacts_insert on public.crm_contacts
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_contacts_update on public.crm_contacts
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_contacts_delete on public.crm_contacts
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_contacts from anon;

-- crm_notes: manual activity log on a contact (append-only, like
-- whatsapp_messages -- no update/delete policy, so once written a note is
-- part of the permanent history).

create table public.crm_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.crm_contacts(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  content text not null,
  created_at timestamptz not null default now()
);

create index crm_notes_contact_id_idx on public.crm_notes(contact_id);

alter table public.crm_notes enable row level security;

create policy crm_notes_select on public.crm_notes
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_notes_insert on public.crm_notes
  for insert with check (
    author_id = auth.uid()
    and (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  );

revoke all on public.crm_notes from anon;

-- Link every conversation to a CRM contact -- nullable because
-- whatsapp-webhook backfills it for inbound messages (see next migration
-- step in the Edge Function), and older/edge-case conversations may not have
-- one yet.
alter table public.whatsapp_conversations add column contact_id uuid references public.crm_contacts(id) on delete set null;
create index whatsapp_conversations_contact_id_idx on public.whatsapp_conversations(contact_id);

-- Tenant users can now start a conversation from the CRM ("nueva
-- conversación" in the Inbox) instead of only ever receiving inbound ones --
-- previously whatsapp_conversations had no authenticated insert policy at
-- all (only service_role, via the webhook).
create policy whatsapp_conversations_insert on public.whatsapp_conversations
  for insert with check (
    (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    and exists (
      select 1 from public.whatsapp_lines wl
      where wl.id = whatsapp_conversations.whatsapp_line_id and wl.tenant_id = whatsapp_conversations.tenant_id
    )
  );
