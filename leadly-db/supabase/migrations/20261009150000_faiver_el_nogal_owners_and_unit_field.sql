-- Faiver Moyano (tenant 7419c825-4d72-45af-bf40-73375eed9f9c): carga de propietarios de
-- El Nogal desde "PROPIETARIOS EL NOGAL.xlsx", campo personalizado "Unidad" y ajuste del
-- prompt del asistente para que sepa de qué consultorio/apartamento le hablan.
--
-- Decisiones (acordadas con el usuario):
--  * La columna DOCUMENTO del Excel repite el número de consultorio, no es un documento
--    de identidad: NO se guarda en clients.document_number (índice único + uso en DIAN).
--  * El número de consultorio va al campo personalizado "Unidad" (texto).
--  * "PARQUEADERO" comparte celular con el consultorio 202: un celular es un solo cliente
--    (índice único), así que se crea aparte y sin celular. La IA no lo alcanza por WhatsApp.
--  * Las filas sin saldo a favor (vacío) se cargan en 0.
--  * Idempotente: se puede reaplicar sin duplicar clientes.

-- 1. Definiciones: renombrar la mora existente (ahora hay dos tipos) y crear las nuevas.
update public.custom_field_definitions
   set name = 'Saldo en mora cuota ordinaria'
 where tenant_id = '7419c825-4d72-45af-bf40-73375eed9f9c'
   and entity_type = 'client'
   and name = 'Saldo en mora'
   and deleted_at is null;

insert into public.custom_field_definitions (tenant_id, entity_type, name, field_type, visible_to_ai, display_order)
select '7419c825-4d72-45af-bf40-73375eed9f9c', 'client', d.name, d.field_type, true, d.display_order
from (values
  ('Unidad',                       'text',    4),
  ('Saldo en mora cuota extra',    'decimal', 5),
  ('Saldo a favor',                'decimal', 6)
) as d(name, field_type, display_order)
where not exists (
  select 1 from public.custom_field_definitions e
  where e.tenant_id = '7419c825-4d72-45af-bf40-73375eed9f9c'
    and e.entity_type = 'client'
    and lower(btrim(e.name)) = lower(d.name)
    and e.deleted_at is null
);

-- 2. Propietarios. Los valores se guardan por id de definición.
do $seed$
declare
  t constant uuid := '7419c825-4d72-45af-bf40-73375eed9f9c';
  f_unidad uuid; f_admin uuid; f_mora uuid; f_extra uuid; f_favor uuid; f_proy uuid;
  n_defs int;
begin
  select
    max(id::text) filter (where name = 'Unidad')::uuid,
    max(id::text) filter (where name = 'Valor de administración')::uuid,
    max(id::text) filter (where name = 'Saldo en mora cuota ordinaria')::uuid,
    max(id::text) filter (where name = 'Saldo en mora cuota extra')::uuid,
    max(id::text) filter (where name = 'Saldo a favor')::uuid,
    max(id::text) filter (where name = 'Proyecto o propiedad')::uuid
  into f_unidad, f_admin, f_mora, f_extra, f_favor, f_proy
  from public.custom_field_definitions
  where tenant_id = t and entity_type = 'client' and is_active and deleted_at is null;

  if f_unidad is null or f_admin is null or f_mora is null or f_extra is null or f_favor is null or f_proy is null then
    raise exception 'Faltan definiciones de campos personalizados para el tenant de Faiver Moyano.';
  end if;

  create temp table _nogal_owners on commit drop as
  select * from (values
    ('ANA PAOLA CUELLAR', '3162391128', '101', 429000, 857600, 0, 0),
    ('YACKELINE OLAYA', '3144136339', '102', 578000, 4571000, 756000, 0),
    ('PARQUEADERO', '', '9', 132000, 696000, 345600, 0),
    ('LINA BARREIRO RAMOS', '3214308693', '201', 721000, 0, 0, 89210),
    ('LUIS ALBERTO AMAYA', '3208924221', '202', 660000, 0, 0, 0),
    ('MARIA PAULA DURAN', '3213437969', '203', 649000, 1035129, 849600, 0),
    ('CONRADO VASCULAR SAS', '3184020129', '301', 825000, 0, 0, 0),
    ('NEILDER MELO PALACIO', '3215662905', '302', 660000, 0, 0, 0),
    ('LUIS EDUARDO CALDERON CLAROS', '3232831034', '303', 649000, 285000, 2731800, 0),
    ('BENAVIDEZ & MORALES SAS', '3166905923', '304', 688000, 526950, 900000, 0),
    ('GERMAN RAMON', '3213083696', '305', 693000, 2522404, 907200, 0),
    ('ENRIQUE CHARRY', '3105797260', '401', 825000, 2700000, 1080000, 0),
    ('JIMMY ESTEBAN NUMA RODRIGUEZ', '3504444034', '402', 649000, 0, 817622, 0),
    ('ALBERTO TRSPALACIOS', '3153231857', '403', 682000, 0, 0, 0),
    ('EFRAIN AMAYA', '3103042463', '404', 682000, 0, 0, 1571200),
    ('UNIDAD DE TRATAMIENTO DEL DOLOR SAS', '3144253404', '405', 677000, 2708000, 0, 0),
    ('YESID VICENTE ACUÑA', '3115809874', '501', 682000, 132000, 317600, 0),
    ('DAVID MUÑOZ', '3156167995', '502', 649000, 2596000, 120600, 0),
    ('LINA DEL CARMEN CASTILLO', '3174294590', '503', 638000, 0, 535200, 0),
    ('LUIS FERNANDO DURAN', '3162471513', '504', 715000, 0, 0, 2353000),
    ('MARLIO CAMPOS', '3163163080', '505', 545000, 1585000, 712800, 0)
  ) as v(full_name, phone, unidad, admin, mora, extra, favor);

  -- Con celular: upsert por (tenant, prefijo, celular).
  insert into public.clients (tenant_id, full_name, phone, phone_prefix, country, custom_fields)
  select t, o.full_name, o.phone, '57', 'CO',
         jsonb_build_object(
           f_proy::text,   'El Nogal',
           f_unidad::text, o.unidad,
           f_admin::text,  o.admin,
           f_mora::text,   o.mora,
           f_extra::text,  o.extra,
           f_favor::text,  o.favor)
  from _nogal_owners o
  where o.phone <> ''
  on conflict (tenant_id, phone_prefix, phone) where deleted_at is null and phone <> ''
  do update set
    full_name     = excluded.full_name,
    custom_fields = public.clients.custom_fields || excluded.custom_fields;

  -- Sin celular (parqueadero): no hay clave de conflicto, se evita duplicar por nombre + unidad.
  insert into public.clients (tenant_id, full_name, phone, phone_prefix, country, custom_fields)
  select t, o.full_name, '', '57', 'CO',
         jsonb_build_object(
           f_proy::text,   'El Nogal',
           f_unidad::text, o.unidad,
           f_admin::text,  o.admin,
           f_mora::text,   o.mora,
           f_extra::text,  o.extra,
           f_favor::text,  o.favor)
  from _nogal_owners o
  where o.phone = ''
    and not exists (
      select 1 from public.clients c
      where c.tenant_id = t and c.deleted_at is null and c.phone = ''
        and c.full_name = o.full_name
        and c.custom_fields ->> f_unidad::text = o.unidad
    );
end
$seed$;

-- 3. Prompt del asistente. Cada reemplazo aborta si el texto de origen no existe
-- (un replace() que no coincide no falla ni avisa).
do $prompt$
declare
  a constant uuid := '9ce9415a-4f24-4092-ac96-6e311c48df68';
  p text;
  pairs text[][] := array[
    array[
      $o$Te devuelve el saldo en mora, el valor de administración y el proyecto o propiedad del cliente que te escribe.$o$,
      $n$Te devuelve los datos del cliente que te escribe: la *Unidad* (número de consultorio o apartamento), el proyecto o propiedad, el valor de administración, el saldo en mora de cuota ordinaria, el saldo en mora de cuota extra y el saldo a favor.
- La *Unidad* te dice de qué consultorio o apartamento te hablan. Cuando respondas datos de su cuenta, nómbrala: "Consultorio 305 de El Nogal". Nunca le preguntes la unidad si ya la tienes. Si no aparece, pregúntale el número antes de dar cifras.
- Cada quien tiene una sola unidad asociada a su número. Si menciona un consultorio distinto al que tienes registrado, no le des datos de ese otro: dile que solo manejas la información de la unidad asociada a este número y que la administración le ayudará con lo demás.
- La mora de cuota ordinaria y la de cuota extra son dos valores distintos: dáselos por separado y no los sumes. Si algún saldo es 0, dile que en ese concepto está al día. Si tiene saldo a favor mayor a 0, menciónalo con claridad y sin prometer cómo se aplicará.$n$
    ],
    array[
      $o$   - *Dónde*: su apartamento o casa (torre/número) o la zona común exacta.$o$,
      $n$   - *Dónde*: su unidad (consultorio o apartamento, que ya tienes en sus datos: no se la preguntes de nuevo) o la zona común exacta si el daño no es en su unidad.$n$
    ],
    array[
      $o$"Fuga de agua – Torre 2 Apto 304"$o$,
      $n$"Fuga de agua – El Nogal, Consultorio 304"$n$
    ]
  ];
  i int;
begin
  select system_prompt into p from public.ai_assistants
  where id = a and tenant_id = '7419c825-4d72-45af-bf40-73375eed9f9c';
  if p is null then
    raise exception 'No se encontró el asistente de Andrés Moyano.';
  end if;

  for i in 1 .. array_length(pairs, 1) loop
    if position(pairs[i][1] in p) = 0 then
      raise exception 'El texto de origen del reemplazo % no existe en el prompt.', i;
    end if;
    p := replace(p, pairs[i][1], pairs[i][2]);
  end loop;

  update public.ai_assistants set system_prompt = p
  where id = a and tenant_id = '7419c825-4d72-45af-bf40-73375eed9f9c';
end
$prompt$;
