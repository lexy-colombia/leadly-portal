-- Image attachments for PQR/seguimientos, from two origins: an agent
-- uploading manually from the CRM, or a customer sending a photo on
-- WhatsApp that the AI links to the case it's creating/updating (see
-- whatsapp-webhook and whatsapp-ai-tools). Images only for now -- no other
-- file types -- and no real AI vision: the model only stores/shows the
-- file, it never sees or interprets pixel content.
create table public.crm_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  pqr_id uuid references public.crm_pqrs(id) on delete cascade,
  pqr_update_id uuid references public.crm_pqr_updates(id) on delete cascade,
  storage_path text not null,
  mime_type text not null,
  size_bytes integer not null,
  original_filename text,
  created_by uuid references public.profiles(id) on delete set null,
  created_by_ai boolean not null default false,
  created_at timestamptz not null default now(),
  constraint crm_attachments_exactly_one_parent check (
    (pqr_id is not null and pqr_update_id is null) or (pqr_id is null and pqr_update_id is not null)
  ),
  constraint crm_attachments_image_only check (mime_type like 'image/%')
);

create index crm_attachments_pqr_id_idx on public.crm_attachments(pqr_id);
create index crm_attachments_pqr_update_id_idx on public.crm_attachments(pqr_update_id);

alter table public.crm_attachments enable row level security;

-- Same shape as crm_pqr_updates: append-only, tenant-scoped select/insert,
-- no update/delete policy.
create policy crm_attachments_select on public.crm_attachments
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy crm_attachments_insert on public.crm_attachments
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_attachments from anon;

-- Lets an inbound WhatsApp photo render in the Inbox chat itself, not only
-- once (if ever) it gets linked to a PQR/seguimiento.
alter table public.whatsapp_messages
  add column media_storage_path text,
  add column media_mime_type text,
  add column media_size_bytes integer;

-- Private bucket (unlike tenant-logos, which is public) -- PQR evidence
-- photos can be sensitive, so they're served via short-lived signed URLs
-- instead of a public URL. Same per-tenant-folder RLS shape as
-- tenant-logos, plus the webhook (service_role, bypasses RLS) uploading
-- photos a customer sends on WhatsApp.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('crm-attachments', 'crm-attachments', false, 8388608, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy crm_attachments_storage_read on storage.objects
  for select using (
    bucket_id = 'crm-attachments'
    and (public.is_superadmin() or (storage.foldername(name))[1] = public.auth_active_tenant_id()::text)
  );

create policy crm_attachments_storage_write on storage.objects
  for insert with check (
    bucket_id = 'crm-attachments'
    and (public.is_superadmin() or (storage.foldername(name))[1] = public.auth_active_tenant_id()::text)
  );

create policy crm_attachments_storage_update on storage.objects
  for update using (
    bucket_id = 'crm-attachments'
    and (public.is_superadmin() or (storage.foldername(name))[1] = public.auth_active_tenant_id()::text)
  );

create policy crm_attachments_storage_delete on storage.objects
  for delete using (
    bucket_id = 'crm-attachments'
    and (public.is_superadmin() or (storage.foldername(name))[1] = public.auth_active_tenant_id()::text)
  );
