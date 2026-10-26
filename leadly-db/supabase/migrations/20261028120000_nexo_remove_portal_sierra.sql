-- Nexo Empresarial (Faiver Moyano): Andrés Moyano ya no administra Portal de la Sierra.
-- 1) Quita de los clientes de ese proyecto el proyecto, la unidad, el valor de administración y los saldos.
-- 2) Deja El Nogal como única opción de "Proyecto o propiedad".
-- 3) Ajusta el prompt: solo El Nogal, y a quien no es de El Nogal se le ofrece el portafolio (productos).
-- 4) Activa la habilidad `catalogo` para que el asistente pueda consultar ese portafolio.

do $$
declare
  v_tenant constant uuid := '7419c825-4d72-45af-bf40-73375eed9f9c';
  v_assistant constant uuid := '9ce9415a-4f24-4092-ac96-6e311c48df68';
  v_project constant text := 'adcbced2-fdf5-4ac2-bd6a-b07b36ae6fd5';
  v_keys constant text[] := array[
    'adcbced2-fdf5-4ac2-bd6a-b07b36ae6fd5', -- Proyecto o propiedad
    '90f8f02c-e3dc-4d48-9a6c-b4dd6a084321', -- Unidad
    'cc3f853b-7be1-43c2-ac60-22d9dee1c203', -- Valor de administración
    '6dfb7ea1-2c72-4f54-ba70-e0956168daf9', -- Saldo en mora cuota ordinaria
    'a10b0b4b-c47e-4b6b-9999-9cfc6bd18438', -- Saldo en mora cuota extra
    '62bd9cf3-d88e-4857-b0e5-ee8e1fff85d1'  -- Saldo a favor
  ];
  v_prompt text;
  v_old text;
  v_new text;
  i int;
  v_from text[];
  v_to text[];
  v_n int;
begin
  -- 1) Clientes de Portal de la Sierra
  update clients
     set custom_fields = custom_fields - v_keys
   where tenant_id = v_tenant
     and custom_fields->>v_project = 'Portal de la Sierra';
  get diagnostics v_n = row_count;
  if v_n <> 109 then
    raise exception 'Se esperaban 109 clientes de Portal de la Sierra y se actualizaron %', v_n;
  end if;

  -- 2) Opciones del campo
  update custom_field_definitions
     set options = '["El Nogal"]'::jsonb
   where id = v_project::uuid and tenant_id = v_tenant;

  -- 3) Prompt (cada reemplazo aborta si el texto de origen no existe)
  select system_prompt into v_prompt from ai_assistants where id = v_assistant and tenant_id = v_tenant;

  v_from := array[
    'quien administra las propiedades *El Nogal* y *Portal de la Sierra*.',
    'si no está el proyecto, pregúntale si es El Nogal o Portal de la Sierra)',
    'y, si pregunta por un proyecto, con project ("El Nogal" o "Portal de la Sierra").',
    '- Hablar de temas ajenos a la administración de estas dos propiedades: di amablemente que solo puedes ayudar con eso.'
  ];
  v_to := array[
    'quien administra la propiedad *El Nogal*.',
    'si no aparece asociado a El Nogal, no registres el daño y sigue la sección 6)',
    'y, si pregunta por un proyecto, con project ("El Nogal").',
    '- Hablar de temas ajenos a la administración de El Nogal y a los servicios del portafolio (sección 6): di amablemente que solo puedes ayudar con eso.'
  ];
  for i in 1 .. array_length(v_from, 1) loop
    if position(v_from[i] in v_prompt) = 0 then
      raise exception 'Texto de origen no encontrado en el prompt: %', v_from[i];
    end if;
    v_prompt := replace(v_prompt, v_from[i], v_to[i]);
  end loop;

  v_old := E'\n\n# Lo que NO puedes hacer';
  if position(v_old in v_prompt) = 0 then
    raise exception 'No se encontró la sección "Lo que NO puedes hacer"';
  end if;
  v_new := E'\n\n## 6. Personas que no son de El Nogal (portafolio de servicios)\n'
    || E'Andrés Moyano administra únicamente El Nogal. Si quien te escribe no está asociado a El Nogal (get_client_custom_fields no trae proyecto ni unidad), no le des datos de cuenta, no registres reportes de daños y no le digas que es cliente de ninguna propiedad.\n'
    || E'- Salúdalo, dile con naturalidad que desde este canal se atiende la administración de El Nogal y ofrécele conocer el *portafolio de servicios* de Andrés Moyano.\n'
    || E'- Para mostrarlo usa list_catalog_products (y list_catalog_categories si hace falta): los servicios están cargados como productos del catálogo. Presenta los nombres con una descripción breve de cada uno y pregunta cuál le interesa; si pide detalle de uno, búscalo por su nombre exacto. Si la herramienta trae el enlace de la tienda o del servicio, compártelo tal cual.\n'
    || E'- No des precios ni tarifas: los honorarios dependen del alcance y los define un asesor. Nunca inventes servicios, condiciones ni plazos que no estén en el catálogo.\n'
    || E'- Si le interesa alguno o quiere una cotización, pídele su nombre y qué necesita, y dile que se lo pasas a una persona del equipo para que lo contacte. No uses create_opportunity: ese pipeline es solo de tickets de daños.\n'
    || E'- Si alguien dice ser propietario de El Nogal pero no tiene unidad asociada, no inventes datos: dile que la administración le ayudará a asociarla.\n'
    || v_old;
  v_prompt := replace(v_prompt, v_old, v_new);

  if position('Portal de la Sierra' in v_prompt) > 0 then
    raise exception 'Quedan menciones de Portal de la Sierra en el prompt';
  end if;

  update ai_assistants set system_prompt = v_prompt where id = v_assistant and tenant_id = v_tenant;

  -- 4) Habilidad de catálogo
  insert into ai_assistant_skills (ai_assistant_id, skill_key)
  values (v_assistant, 'catalogo')
  on conflict do nothing;
end $$;
