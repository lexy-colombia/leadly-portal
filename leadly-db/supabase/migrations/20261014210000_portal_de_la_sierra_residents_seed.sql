-- Faiver Moyano (tenant 7419c825-4d72-45af-bf40-73375eed9f9c): carga de residentes de
-- Portal de la Sierra (torres 3 y 4) desde "LISTADO ENVIAR A SEBASTIAN.xlsx", sobre los
-- campos personalizados que ya existen (no se crea ninguno).
--
-- Criterios:
--  * Unidad = "Torre T Apto N". Proyecto o propiedad = "Portal de la Sierra".
--  * Valor de administración = cuota de octubre de la fila.
--  * Deuda vigente = columna "total" final del Excel (arrastre + cuotas jul-oct - pagos),
--    verificada fila por fila. Cuota extra = extra 2025 + actividades San Pedro/Navidad +
--    extra 2026; mora ordinaria = deuda vigente - cuota extra (incluye parqueadero y retroactivos).
--  * Cada concepto con valor negativo no es mora: se suma en "Saldo a favor".
--  * Un celular es un solo cliente: si repite en varias filas (Linda Juliana Jimenez: 203, 901
--    y 902; 702 y 703), queda un cliente con las unidades unidas y los valores sumados.
--  * Torre 4 apto 1502 trae 8609858959 (no es celular) y 1303 no trae celular: se cargan sin
--    celular, como el parqueadero de El Nogal.
--  * La cédula no se carga (se repite entre unidades y no era parte del pedido).
--  * Idempotente.

do $seed$
declare
  t constant uuid := '7419c825-4d72-45af-bf40-73375eed9f9c';
  f_unidad uuid; f_admin uuid; f_mora uuid; f_extra uuid; f_favor uuid; f_proy uuid;
  n_clash int;
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

  create temp table _portal_owners on commit drop as
  select * from (values
    ('AMIRA CABRERA POLANCO', '3103292746', 'Torre 3 Apto 201', 544320, 2177280, 0, 0),
    ('JAVIER BARRERO', '3186081555', 'Torre 3 Apto 202', 544320, 2721600, 0, 0),
    ('LINDA JULIANA JIMENEZ', '3157316666', 'Torre 3 Apto 203 y Torre 3 Apto 901 y Torre 3 Apto 902', 1572480, 7839400, 0, 0),
    ('ALICIA DUSSAN', '3112219390', 'Torre 3 Apto 204', 544320, 2177280, 0, 0),
    ('CRISTIAN AMERICO RODRIGUEZ NIETO', '3203693007', 'Torre 3 Apto 301', 544320, 2358880, 0, 0),
    ('Cristian Americo Nieto', '3176700057', 'Torre 3 Apto 302', 544320, 12187808, 0, 0),
    ('DIANA BORRERO', '3153321479', 'Torre 3 Apto 303', 483840, 2419200, 0, 0),
    ('MEIFA TOVAR HERNANDEZ', '3143572575', 'Torre 3 Apto 304', 544320, 2176880, 0, 200000),
    ('ALVARO POLANIA RAMIREZ', '3212855708', 'Torre 3 Apto 401', 544320, 2419200, 0, 0),
    ('OLGA CASTRILLON GARCIA', '3166973991', 'Torre 3 Apto 402', 544320, 2902880, 280000, 0),
    ('CUELLAR LEONOR', '3204881482', 'Torre 3 Apto 403', 483840, 2134560, 280000, 0),
    ('FANNY TOVAR', '3167449798', 'Torre 3 Apto 404', 544320, 2177280, 0, 0),
    ('YENNY ANDREA LLANOS', '3214865600', 'Torre 3 Apto 501', 544320, 0, 0, 424000),
    ('SAMUEL PERDOMO LAVAO', '3124815465', 'Torre 3 Apto 502', 544320, 2266560, 200000, 0),
    ('FRANCISCO JOSE GARCIA LARA', '3215060371', 'Torre 3 Apto 503', 483840, 1935440, 0, 0),
    ('KAROL VANESA ORTIGOZA VARGAS', '3202034181', 'Torre 3 Apto 504', 544320, 3427200, 200000, 0),
    ('Sonia Lorena Fierro R', '3209013620', 'Torre 3 Apto 601', 544320, 2681280, 0, 0),
    ('AMINA SUAREZ', '3174300493', 'Torre 3 Apto 602', 544320, 2177280, 0, 0),
    ('CARLOS GUTIERREZ QUIGUA', '3157357235', 'Torre 3 Apto 603', 483840, 1935360, 0, 0),
    ('TRINY GONZALEZ GONZALEZ', '3103069030', 'Torre 3 Apto 604', 544320, 3729600, 0, 0),
    ('ANA MILENA CARDOZO MEJIA', '3143361008', 'Torre 3 Apto 701', 483840, 1409600, 0, 0),
    ('ELIZABETH PERDOMO', '3183530275', 'Torre 3 Apto 702 y Torre 3 Apto 703', 1028160, 4152720, 0, 400000),
    ('DIEGO OMAR TOVAR TOVAR', '3175124702', 'Torre 3 Apto 704', 483840, 1935360, 0, 0),
    ('GERMAN VARGAS', '3173817437', 'Torre 3 Apto 801', 544320, 3939200, 200000, 0),
    ('MILCIADES ARDILA', '3108723694', 'Torre 3 Apto 802', 544320, 678000, 0, 0),
    ('LUIS EVELIO', '3176365700', 'Torre 3 Apto 803', 483840, 4695040, 0, 0),
    ('EDGAR GAMBOA PEÑA', '3152054347', 'Torre 3 Apto 804', 483840, 1308160, 0, 0),
    ('Nelly Mendez Barrios', '3124149720', 'Torre 3 Apto 903', 483840, 1935440, 0, 0),
    ('Orlando Ardila Trujillo', '3178006369', 'Torre 3 Apto 904', 544320, 1527230, 0, 200000),
    ('RAFAEL GONZALEZ STERLING', '3183505287', 'Torre 3 Apto 1001', 544320, 1823200, 200000, 0),
    ('MARIA ALEJANDRA ALARCON ORJUELA', '3213612595', 'Torre 3 Apto 1002', 544320, 3427200, 200000, 0),
    ('MARTHA INES ALARCON', '3008563221', 'Torre 3 Apto 1003', 483840, 2419200, 0, 0),
    ('Jose Vladimir Guzman Rivera', '3134412866', 'Torre 3 Apto 1004', 544320, 2177280, 0, 200000),
    ('ELSA CECILIA NAVARRETE TAMAYO', '3112339587', 'Torre 3 Apto 1101', 544320, 2392560, 200000, 0),
    ('Conjunto residencial conjunto portal de la sierra etapa 1', '3115177735', 'Torre 3 Apto 1102', 544320, 4869560, 4044825, 0),
    ('INVERSIONES CAHOMI S.A.S', '3168705287', 'Torre 3 Apto 1103', 483840, 4092672, 6125720, 0),
    ('ANGELICA MARIA MAHECHA POLANIA', '3166942008', 'Torre 3 Apto 1104', 544320, 2177280, 0, 0),
    ('JAIRO ARMANDO BELTRAN RUIZ', '3164727477', 'Torre 3 Apto 1201', 544320, 1128640, 0, 0),
    ('LIBARDO CABRERA FERNANDEZ', '3108184441', 'Torre 3 Apto 1202', 544320, 2177320, 0, 0),
    ('INVERSIONES CAHOMI S.A.S', '3203448389', 'Torre 3 Apto 1203', 483840, 2488000, 0, 0),
    ('FRANCISCO LEONARDO ORTIZ MENDIETA', '3212087778', 'Torre 3 Apto 1204', 544320, 4435200, 80000, 0),
    ('JAVIER GARCIA LOZADA', '3153231532', 'Torre 3 Apto 1301', 544320, 2231040, 0, 200000),
    ('SANDRA MARCELA EMBUS', '3133892674', 'Torre 3 Apto 1302', 544320, 2338560, 200000, 0),
    ('David Hernández', '3212055828', 'Torre 3 Apto 1303', 483840, 9927040, 0, 0),
    ('GLORIA INES CANO DUSSAN', '3202806508', 'Torre 3 Apto 1304', 544320, 2177280, 0, 0),
    ('CARLOS ALBERTO MEDINA CUELLAR', '3153077021', 'Torre 3 Apto 1401', 544320, 2227280, 0, 0),
    ('RAMIRO CHARRY', '3138564044', 'Torre 3 Apto 1402', 544320, 2177280, 170000, 0),
    ('Sindy Cespedes', '3003860893', 'Torre 3 Apto 1403', 483840, 4694540, 0, 0),
    ('Carolina Cuéllar', '3153453727', 'Torre 3 Apto 1404', 544320, 2147280, 0, 0),
    ('MAGDA CLARIZA BELTRAN MOSQUERA', '3105294152', 'Torre 3 Apto 1501', 544320, 3427200, 200000, 0),
    ('Luis Alberto Granados', '3152638288', 'Torre 3 Apto 1502', 544320, 1672960, 0, 0),
    ('Darwin', '3103466038', 'Torre 3 Apto 1503', 483840, 13272894, 0, 0),
    ('Oscar Iván Polo', '3212082620', 'Torre 3 Apto 1504', 544320, 624320, 0, 0),
    ('ALEJANDRO VALDERRAMA OLAYA', '3114653816', 'Torre 4 Apto 201', 544320, 1874880, 0, 0),
    ('Fanny Achito de Suarez', '3112891568', 'Torre 4 Apto 202', 483840, 3495040, 0, 0),
    ('JHON EDISON JORDAN TEJADA', '3163315049', 'Torre 4 Apto 203', 544320, 2882880, 80000, 0),
    ('Aurora Segura León', '3105554246', 'Torre 4 Apto 204', 544320, 2177280, 0, 0),
    ('JUAN FELIPE CUENCA CHACON', '3002162630', 'Torre 4 Apto 301', 544320, 2156280, 200000, 0),
    ('Elberto Garavito Vargas', '3175009700', 'Torre 4 Apto 302', 483840, 1099200, 0, 0),
    ('HERNANDO ALVARADO SERRATO', '3043768451', 'Torre 4 Apto 303', 483840, 726080, 0, 0),
    ('SERGIO JARAMILLO CUELLAR', '3132102457', 'Torre 4 Apto 304', 544320, 2721600, 0, 0),
    ('ELIZABETH NIETO COMETA', '3176371253', 'Torre 4 Apto 401', 544320, 2177280, 80000, 0),
    ('ALFONSO DIAZ LLANO', '3138575136', 'Torre 4 Apto 402', 483840, 1935440, 0, 0),
    ('DIANA ISABEL OLIVAR VOLOJ', '3176439107', 'Torre 4 Apto 403', 544320, 1652960, 0, 0),
    ('Margareth Ortiz', '3168767484', 'Torre 4 Apto 404', 544320, 4697920, 0, 0),
    ('JAIME ARIAS LIZCANO', '3102356056', 'Torre 4 Apto 501', 544320, 1128640, 0, 0),
    ('LUZ MARGOTH MONCALEANO GOMEZ', '3173770702', 'Torre 4 Apto 502', 483840, 1935440, 0, 0),
    ('SILVIA MADDY BUITRAGO DE ARTUNDUAGA', '3136747011', 'Torre 4 Apto 503', 544320, 2197280, 0, 0),
    ('DIANA CAROLINA ALDANA GASCA', '3168741281', 'Torre 4 Apto 504', 544320, 2178560, 0, 0),
    ('NOHORA VEGA ESCOBAR', '3185575566', 'Torre 4 Apto 601', 544320, 1128640, 0, 0),
    ('ALCIBIADES QUIROZ OLAYA', '3205493148', 'Torre 4 Apto 602', 483840, 2094720, 200000, 0),
    ('LEAL MORENO ESPERANZA INES DE LA CRUZ', '3122575489', 'Torre 4 Apto 603', 544320, 4939240, 343360, 0),
    ('LINA ISABEL CABRALES MONTAÑO', '3188711797', 'Torre 4 Apto 604', 544320, 2177280, 0, 0),
    ('ELSA CRISTINA MORENO BRAVO', '3142057003', 'Torre 4 Apto 701', 544320, 1709440, 0, 0),
    ('GUSTAVO SANDOVAL CASTRO', '3015813670', 'Torre 4 Apto 702', 483840, 1471360, 0, 0),
    ('GINETH BUSTOS GUTIERREZ', '3176691380', 'Torre 4 Apto 703', 544320, 2177280, 0, 200000),
    ('DIANA MILENY CORTES CEDIEL', '3222559228', 'Torre 4 Apto 704', 544320, 5231200, 200000, 0),
    ('JUAN. CARLOS PÓVEDA VELASQUEZ', '3134679509', 'Torre 4 Apto 801', 544320, 4521800, 0, 0),
    ('LEAL MORENO ESPERANZA INES DE LA CRUZ', '3134225453', 'Torre 4 Apto 802', 483840, 2419200, 80000, 0),
    ('Nubia Falla', '3105380644', 'Torre 4 Apto 803', 544320, 2197280, 0, 0),
    ('MARIA EUGENIA PULECIO DE GARCIA', '3176547352', 'Torre 4 Apto 804', 544320, 2177280, 0, 200000),
    ('ORLANDO PERDOMO FLOREZ', '3112156334', 'Torre 4 Apto 901', 544320, 2177280, 0, 200000),
    ('ANGELITA POLANIA PUENTES', '3112268021', 'Torre 4 Apto 902', 483840, 1935360, 0, 0),
    ('FERNANDO AUGUSTO PENNA TASCON', '3006197573', 'Torre 4 Apto 903', 544320, 3427200, 200000, 0),
    ('Marleny Llanos Medina', '3153570848', 'Torre 4 Apto 904', 544320, 2177280, 0, 0),
    ('IDEAS S.A.S', '3012789666', 'Torre 4 Apto 1001', 544320, 3738680, 200000, 0),
    ('FAIVER AROCA', '3157351025', 'Torre 4 Apto 1002', 483840, 4390400, 0, 0),
    ('RONALD LEONARDO GARCIA ESQUIVEL', '3214639606', 'Torre 4 Apto 1003', 544320, 1652360, 0, 50000),
    ('AIDALIGIA ORDOÑEZ MUÑOZ', '3006196699', 'Torre 4 Apto 1004', 544320, 2242560, 0, 200000),
    ('NATALY GARZON MOLINA', '3160493523', 'Torre 4 Apto 1101', 544320, 2097280, 0, 0),
    ('DAVID DURAN BAHAMON', '3014312049', 'Torre 4 Apto 1102', 483840, 1451440, 0, 400000),
    ('JUAN CAMILO PASCUAS TRUJILLO', '3142984925', 'Torre 4 Apto 1103', 544320, 1128970, 0, 200000),
    ('LUIS HUMBERTO VILLARUEL', '3158974636', 'Torre 4 Apto 1104', 544320, 2177280, 0, 200000),
    ('EDUARDO DUSSAN NAVARRO', '3196443654', 'Torre 4 Apto 1201', 544320, 16891200, 1075600, 0),
    ('SANDRA MILENA CERQUERA PEREZ', '3202303555', 'Torre 4 Apto 1202', 483840, 1935440, 0, 0),
    ('MARIA ALEJANDRA NARANJO TAFUR', '3124350885', 'Torre 4 Apto 1203', 544320, 3648960, 80000, 0),
    ('ORLANDO ARIAS RUJANA', '3183678154', 'Torre 4 Apto 1204', 544320, 2701600, 0, 0),
    ('SILVIA LEONOR OSORIO GALINDO', '3123438702', 'Torre 4 Apto 1301', 544320, 2721600, 0, 0),
    ('OLGA QUIGUA HERMOSA', '3106987895', 'Torre 4 Apto 1302', 483840, 206200, 0, 0),
    ('JUAN DAVID POTILLO ARANGO', '', 'Torre 4 Apto 1303', 544320, 2187080, 577800, 0),
    ('Julián Berrio', '3158924797', 'Torre 4 Apto 1304', 544320, 2177280, 0, 0),
    ('CLAUDIA MERCEDES AZUERO', '3104937722', 'Torre 4 Apto 1401', 544320, 2152300, 0, 200000),
    ('LUIS EDUARDO ZABALA CORDOBA', '3183380491', 'Torre 4 Apto 1402', 483840, 1971200, 180000, 0),
    ('LUIS EDUARDO MANRIQUE ORTEGA', '3208213067', 'Torre 4 Apto 1403', 544320, 2721600, 0, 9992),
    ('Nohemí Leiva Trujillo', '3154485424', 'Torre 4 Apto 1404', 544320, 2137280, 0, 0),
    ('OMAR CASTRO PARRA', '3208355414', 'Torre 4 Apto 1501', 544320, 2177280, 80000, 0),
    ('LEONIDAS MORA LOSADA', '', 'Torre 4 Apto 1502', 483840, 1935360, 80000, 0),
    ('CONSTANZA LUGO MONTES', '3183220059', 'Torre 4 Apto 1503', 544320, 11941200, 1275600, 0),
    ('RICARDO VALENZUELA T.', '3002892384', 'Torre 4 Apto 1504', 544320, 0, 280000, 1351200)
  ) as v(full_name, phone, unidad, admin, mora, extra, favor);

  -- Un celular ya existente que no sea de Portal de la Sierra no se pisa.
  select count(*) into n_clash
  from _portal_owners o
  join public.clients c on c.tenant_id = t and c.deleted_at is null
   and c.phone_prefix = '57' and c.phone = o.phone
  where o.phone <> ''
    and coalesce(c.custom_fields ->> f_proy::text, '') <> 'Portal de la Sierra';
  if n_clash > 0 then
    raise exception 'Hay % celulares que ya pertenecen a otros clientes del tenant.', n_clash;
  end if;

  insert into public.clients (tenant_id, full_name, phone, phone_prefix, country, custom_fields)
  select t, o.full_name, o.phone, '57', 'CO',
         jsonb_build_object(
           f_proy::text,   'Portal de la Sierra',
           f_unidad::text, o.unidad,
           f_admin::text,  o.admin,
           f_mora::text,   o.mora,
           f_extra::text,  o.extra,
           f_favor::text,  o.favor)
  from _portal_owners o
  where o.phone <> ''
  on conflict (tenant_id, phone_prefix, phone) where deleted_at is null and phone <> ''
  do update set
    full_name     = excluded.full_name,
    custom_fields = public.clients.custom_fields || excluded.custom_fields;

  insert into public.clients (tenant_id, full_name, phone, phone_prefix, country, custom_fields)
  select t, o.full_name, '', '57', 'CO',
         jsonb_build_object(
           f_proy::text,   'Portal de la Sierra',
           f_unidad::text, o.unidad,
           f_admin::text,  o.admin,
           f_mora::text,   o.mora,
           f_extra::text,  o.extra,
           f_favor::text,  o.favor)
  from _portal_owners o
  where o.phone = ''
    and not exists (
      select 1 from public.clients c
      where c.tenant_id = t and c.deleted_at is null and c.phone = ''
        and c.full_name = o.full_name
        and c.custom_fields ->> f_unidad::text = o.unidad
    );
end
$seed$;
