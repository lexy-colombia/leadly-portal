-- Reject new audio/video uploads; images and stickers remain private.
update storage.buckets set allowed_mime_types = array[
'image/png','image/jpeg','image/webp','application/pdf'
], file_size_limit=8388608
where id='crm-attachments' and public=false;
