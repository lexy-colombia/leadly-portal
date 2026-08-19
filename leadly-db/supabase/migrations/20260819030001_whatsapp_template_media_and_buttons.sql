-- Encabezado de imagen + botones en plantillas de WhatsApp -- cierra el
-- "Fase 1: sin encabezado/imagen/botones" que dejó documentado
-- 20260818204612_whatsapp_message_templates.sql. Alcance deliberado de esta
-- ronda: encabezado solo de tipo IMAGE (no video/documento/texto) y botones
-- estáticos (QUICK_REPLY / URL / PHONE_NUMBER, sin URL dinámica con
-- {{1}}) -- un botón tipo FLOW se suma más adelante cuando exista el
-- proyecto de WhatsApp Flows, no se modela un placeholder vacío ahora.

alter table public.whatsapp_message_templates
  add column header_image_path text,
  add column buttons jsonb not null default '[]'::jsonb;

comment on column public.whatsapp_message_templates.header_image_path is
  'Ruta en el bucket whatsapp-template-media (o null sin encabezado de imagen). La imagen se sube una sola vez y se reusa tanto para pedirle a Meta el "handle" de aprobación como para el parámetro de header en cada envío.';
comment on column public.whatsapp_message_templates.buttons is
  'Array de hasta 3 botones estáticos: [{type: "QUICK_REPLY"|"URL"|"PHONE_NUMBER", text, url?, phone_number?}]. Validado en profundidad (shape, límites por tipo) en whatsapp-manage-templates -- acá solo se resguarda la forma general.';

alter table public.whatsapp_message_templates
  add constraint whatsapp_message_templates_buttons_is_array
    check (jsonb_typeof(buttons) = 'array'),
  add constraint whatsapp_message_templates_buttons_max_three
    check (jsonb_array_length(buttons) <= 3);

comment on table public.whatsapp_message_templates is 'Tenant-owned WhatsApp HSM templates submitted to Meta for approval against the tenant''s WABA (business_account_id). Cuerpo con variables posicionales {{n}}, encabezado de imagen opcional, hasta 3 botones estáticos.';

-- Mismo patrón que el bucket público product-images (20260808182120): el
-- header de una plantilla se manda a Meta como link directo en cada envío,
-- así que necesita ser públicamente accesible sin generar una URL firmada
-- por request.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('whatsapp-template-media', 'whatsapp-template-media', true, 5242880, array['image/png', 'image/jpeg'])
on conflict (id) do nothing;

create policy whatsapp_template_media_storage_read on storage.objects
  for select using (bucket_id = 'whatsapp-template-media');

create policy whatsapp_template_media_storage_write on storage.objects
  for insert with check (
    bucket_id = 'whatsapp-template-media'
    and (public.is_superadmin() or (storage.foldername(name))[1] = public.auth_active_tenant_id()::text)
  );

create policy whatsapp_template_media_storage_delete on storage.objects
  for delete using (
    bucket_id = 'whatsapp-template-media'
    and (public.is_superadmin() or (storage.foldername(name))[1] = public.auth_active_tenant_id()::text)
  );
