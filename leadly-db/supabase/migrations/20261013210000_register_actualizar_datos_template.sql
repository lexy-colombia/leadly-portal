-- Registra en la app la plantilla "actualizar_datos_administracion" de Faiver Moyano.
--
-- La plantilla ya fue creada en Meta (Graph API, WABA 1763408151546034) el
-- 2026-10-13 y quedo en revision: meta_template_id 2591411741370173, categoria
-- UTILITY. Esta migracion solo deja su registro local en
-- whatsapp_message_templates para que aparezca en Campanas; el estado real lo
-- trae la sincronizacion con Meta (whatsapp-manage-templates).
--
-- Idempotente: si ya existe una plantilla viva con ese nombre en el tenant, no
-- hace nada. Aborta si el tenant o la linea no son los esperados.
do $$
declare
  c_tenant constant uuid := '7419c825-4d72-45af-bf40-73375eed9f9c';
  c_waba constant text := '1763408151546034';
  c_meta_id constant text := '2591411741370173';
  c_name constant text := 'actualizar_datos_administracion';
  v_n integer;
begin
  perform 1 from public.whatsapp_lines
   where tenant_id = c_tenant and business_account_id = c_waba;
  if not found then
    raise exception 'register_actualizar_datos_template: el tenant % no tiene la linea con WABA %; no se escribe nada', c_tenant, c_waba;
  end if;

  select count(*) into v_n from public.whatsapp_message_templates
   where tenant_id = c_tenant and name = c_name and deleted_at is null;
  if v_n > 0 then
    raise notice 'register_actualizar_datos_template: ya registrada; nada que hacer';
    return;
  end if;

  insert into public.whatsapp_message_templates (
    tenant_id, business_account_id, meta_template_id, name, category, language,
    status, body_text, variable_count, buttons
  ) values (
    c_tenant, c_waba, c_meta_id, c_name, 'UTILITY', 'es',
    'PENDING',
    'Hola {{1}}, te escribimos de la administración de {{2}}. Para enviarte avisos y el estado de cuenta de la unidad {{3}}, necesitamos confirmar tus datos de contacto.',
    3,
    jsonb_build_array(
      jsonb_build_object('type', 'QUICK_REPLY', 'text', 'Actualizar mis datos'),
      jsonb_build_object('type', 'QUICK_REPLY', 'text', 'Más tarde'),
      jsonb_build_object('type', 'QUICK_REPLY', 'text', 'No deseo recibir mensajes')
    )
  );

  raise notice 'register_actualizar_datos_template: registrada (meta_template_id %)', c_meta_id;
end
$$;
