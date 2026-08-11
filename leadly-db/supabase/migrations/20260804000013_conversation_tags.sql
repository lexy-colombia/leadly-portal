-- Fixed per-tenant catalog of conversation tags -- distinct from `category`
-- (a single value picked from a fixed global enum): tags are open-ended
-- labels the tenant defines for itself, and a conversation can carry several
-- at once. The catalog itself is admin-managed (create/delete), same split
-- as inviting agents; any tenant member can still assign existing tags to a
-- conversation (see conversation_tag_assignments below, no admin check there).
create table public.conversation_tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

alter table public.conversation_tags enable row level security;

create policy conversation_tags_select on public.conversation_tags
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy conversation_tags_insert on public.conversation_tags
  for insert with check (
    (tenant_id = public.auth_active_tenant_id() and public.is_tenant_admin()) or public.is_superadmin()
  );

create policy conversation_tags_delete on public.conversation_tags
  for delete using (
    (tenant_id = public.auth_active_tenant_id() and public.is_tenant_admin()) or public.is_superadmin()
  );

revoke all on public.conversation_tags from anon;

-- Many-to-many: a conversation can have several tags, a tag can be used on
-- several conversations. Scoped through whatsapp_conversations' own tenant
-- rather than duplicating tenant_id here.
create table public.conversation_tag_assignments (
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  tag_id uuid not null references public.conversation_tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (conversation_id, tag_id)
);

create index conversation_tag_assignments_tag_id_idx on public.conversation_tag_assignments(tag_id);

alter table public.conversation_tag_assignments enable row level security;

create policy conversation_tag_assignments_select on public.conversation_tag_assignments
  for select using (
    exists (
      select 1 from public.whatsapp_conversations c
      where c.id = conversation_tag_assignments.conversation_id
      and (c.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    )
  );

create policy conversation_tag_assignments_insert on public.conversation_tag_assignments
  for insert with check (
    exists (
      select 1 from public.whatsapp_conversations c
      where c.id = conversation_tag_assignments.conversation_id
      and (c.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    )
  );

create policy conversation_tag_assignments_delete on public.conversation_tag_assignments
  for delete using (
    exists (
      select 1 from public.whatsapp_conversations c
      where c.id = conversation_tag_assignments.conversation_id
      and (c.tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
    )
  );

revoke all on public.conversation_tag_assignments from anon;
