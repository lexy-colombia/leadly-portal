-- Storage configuration for inbound WhatsApp videos. Keep the bucket private.
-- Existing client-side upload limits remain unchanged.
update storage.buckets
set allowed_mime_types = array(
  select distinct mime from unnest(
    coalesce(allowed_mime_types, array['image/png','image/jpeg','image/webp','application/pdf'])
    || array['video/mp4','video/3gpp']
  ) as mime
),
file_size_limit = greatest(coalesce(file_size_limit,16777216),16777216)
where id = 'crm-attachments' and public = false;
