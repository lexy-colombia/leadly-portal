-- Extends crm_attachments (previously PQR-only) to also attach to a
-- crm_tasks row -- "adjuntar un archivo a la tarea, por si se envió una
-- propuesta" (user request, 2026-08-06). A task attachment is very likely a
-- proposal/quote PDF, not a photo, so the image-only constraint from
-- 20260804000019 (justified there by "no real AI vision" on PQR photos --
-- irrelevant here, a task attachment is never touched by the AI) is relaxed
-- to also allow application/pdf.

alter table public.crm_attachments add column task_id uuid references public.crm_tasks(id) on delete cascade;
create index crm_attachments_task_id_idx on public.crm_attachments(task_id);

alter table public.crm_attachments drop constraint crm_attachments_exactly_one_parent;
alter table public.crm_attachments add constraint crm_attachments_exactly_one_parent check (
  (case when pqr_id is not null then 1 else 0 end)
  + (case when pqr_update_id is not null then 1 else 0 end)
  + (case when task_id is not null then 1 else 0 end) = 1
);

alter table public.crm_attachments drop constraint crm_attachments_image_only;
alter table public.crm_attachments add constraint crm_attachments_mime_type_allowed check (
  mime_type like 'image/%' or mime_type = 'application/pdf'
);

update storage.buckets
set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'application/pdf']
where id = 'crm-attachments';
