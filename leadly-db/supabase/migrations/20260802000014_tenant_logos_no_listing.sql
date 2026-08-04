-- Security advisor finding: tenant_logos_public_read (`bucket_id = 'tenant-logos'`,
-- no path restriction) let any caller enumerate every file in the bucket via
-- the Storage API's list()/get, including other tenants' logo paths (which
-- embed tenant UUIDs). That policy was also unnecessary: `tenant-logos` is a
-- public bucket, so direct object URLs (/storage/v1/object/public/...) are
-- served without consulting storage.objects RLS at all. Drop the policy --
-- public URL access keeps working, API-level listing no longer does.
drop policy tenant_logos_public_read on storage.objects;
