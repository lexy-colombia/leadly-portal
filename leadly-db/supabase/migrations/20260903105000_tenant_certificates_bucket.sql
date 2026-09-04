-- Bucket privado para el certificado digital (.p12/.pfx) que cada tenant
-- sube para firmar sus propias facturas electrónicas. Mismo esqueleto que
-- crm-attachments (bucket privado, 4 policies de storage.objects juntas en
-- la misma migración -- supabase.storage.upload() hace `insert ... returning
-- *`, que necesita una policy de select o falla con un error genérico de
-- RLS), pero escritura/lectura limitada a tenant_admin (no tenant_agent).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tenant-certificates', 'tenant-certificates', false, 524288,
        array['application/x-pkcs12', 'application/octet-stream'])
on conflict (id) do nothing;

create policy tenant_certificates_read on storage.objects for select using (
  bucket_id = 'tenant-certificates'
  and (public.is_superadmin() or (public.is_tenant_admin() and (storage.foldername(name))[1] = public.auth_active_tenant_id()::text))
);
create policy tenant_certificates_insert on storage.objects for insert with check (
  bucket_id = 'tenant-certificates'
  and (public.is_superadmin() or (public.is_tenant_admin() and (storage.foldername(name))[1] = public.auth_active_tenant_id()::text))
);
create policy tenant_certificates_update on storage.objects for update using (
  bucket_id = 'tenant-certificates'
  and (public.is_superadmin() or (public.is_tenant_admin() and (storage.foldername(name))[1] = public.auth_active_tenant_id()::text))
);
create policy tenant_certificates_delete on storage.objects for delete using (
  bucket_id = 'tenant-certificates'
  and (public.is_superadmin() or (public.is_tenant_admin() and (storage.foldername(name))[1] = public.auth_active_tenant_id()::text))
);
