-- Barriles de la sexta: asistente de IA de la carta + descripciones de los
-- platos (tomadas del menú impreso que entregó el usuario, 2026-10-06).
--
-- 1. products.description de los platos que salen en el menú impreso (el
--    asistente y el pie de foto del catálogo las usan; hoy 0 de 97 tenían).
--    Cada paso verifica cuántas filas tocó y aborta si no son las esperadas.
-- 2. Módulos aiAgents / channels / conversations habilitados para el tenant
--    (necesarios para ver y operar el asistente y conectar la línea).
-- 3. Asistente "Asistente de Barriles de la sexta" con las habilidades
--    `catalogo` y `clientes`. NO tiene la habilidad de facturación porque esa
--    herramienta todavía no existe (ver progress/feature_ai_facturacion_chat.md):
--    el prompt lo dice de forma explícita para que no prometa lo que no puede
--    hacer. Queda SIN línea de WhatsApp asignada (el tenant no tiene ninguna).

do $$
declare
  v_tenant constant uuid := '9c79437d-1c19-4edc-bc1f-0dc06094823a';
  v_assistant uuid;
  v_count int;
begin
  -- 1. Descripciones ---------------------------------------------------
  with d(name, descr) as (values
    ('Patacones con hogao', '4 crujientes tostones de plátano acompañados de la tradicional salsa hogao.'),
    ('Chicharrones', 'Tocino de cerdo, acompañado de arepa de maíz.'),
    ('Nuggets de pollo', 'Trozos jugosos de pollo empanizados, acompañados de papas a la francesa.'),
    ('Hamburguesa especial al barril', 'Acompañada de papas a la francesa y una deliciosa salsa de la casa.'),
    ('Pechuga a la plancha', 'Pechuga de pollo a la plancha, acompañada de papas a la francesa y ensalada.'),
    ('Pollo a la grille', 'Pechuga de pollo grillada y adobada con finas hierbas, acompañada de maduro relleno de queso, crema de leche, durazno y ensalada.'),
    ('Pechuga hawaiana', 'Filete de pechuga de pollo, bañado en una exquisita salsa hawaiana, acompañado de arroz y papas a la francesa.'),
    ('Pechuga en salsa de champiñones', 'Filete de pechuga de pollo, bañada en una deliciosa salsa de champiñones, acompañada de arroz y papas a la francesa.'),
    ('Pechuga en salsa bourguinon', 'Filete de pechuga de pollo seleccionada, bañada en una exquisita salsa bechamel, acompañada de arroz blanco y papas a la francesa.'),
    ('Bandeja paisa', 'Una deliciosa combinación de arroz, chorizo, carne molida, aguacate, chicharrón, arepa, patacón y huevo.'),
    ('Churrasco', 'Filete de lomo ancho a la plancha, acompañado de papas a la francesa y ensalada.'),
    ('Lengua en salsa', 'Bañada en nuestra exquisita salsa criolla, acompañada de arroz, papas al vapor y ensalada.'),
    ('Lengua en champiñones', 'Bañada en salsa de champiñones, acompañada de arroz, papas a la francesa y ensalada.'),
    ('Sobrebarriga en salsa', 'Sobrebarriga bañada en nuestra salsa criolla, acompañada de arroz, papas al vapor y ensalada.'),
    ('Sobrebarriga dorada', 'Sobrebarriga dorada, acompañada de arroz, papas a la francesa y ensalada.'),
    ('Lomo de cerdo a la plancha', 'Filete de lomo de cerdo, acompañado de papas a la francesa y ensalada.'),
    ('Cerdo a la milanesa', 'Filete de lomo de cerdo empanizado, acompañado de papas a la francesa y ensalada.'),
    ('Lomo de cerdo hawaiano', 'Filete de lomo de cerdo, bañado en salsa de piña, acompañado de arroz y papas a la francesa.'),
    ('Costilla de cerdo ahumada al barril', 'Costilla de cerdo ahumada acompañada de patacones, ensalada y papas a la francesa.'),
    ('Tabla mixta al barril', 'Filete de res, pollo y cerdo a la brasa, acompañado de patacones, papas a la francesa y ensalada.'),
    ('Picada al barril', 'Porciones de res, pollo y cerdo a la brasa, bañadas en nuestra exquisita salsa al barril, acompañadas de patacones, papas a la francesa y arroz.'),
    ('Mojarra carta', 'Mojarra dorada acompañada de patacones y ensalada.'),
    ('Viudo de bocachico', 'Bocachico acompañado de plátano verde, papa, yuca, mazorca y porción de arroz.'),
    ('Bagre a la criolla', 'Porción de bagre en una deliciosa salsa criolla, acompañada de arroz, papa y ensalada.'),
    ('Trucha al ajillo', 'Filete de trucha deshuesada en una exquisita salsa de ajo, acompañada de arroz, papas a la francesa y ensalada.'),
    ('Trucha a la marinera', 'Filete de trucha deshuesada, marinado, acompañado de arroz, papa a la francesa y ensalada.'),
    -- El menú impreso describe este plato con texto de trucha (error de copia
    -- del menú); se redacta sin ese detalle y con los acompañamientos que sí
    -- lista.
    ('Filete de mojarra a la plancha', 'Filete de mojarra a la plancha, acompañado de arroz, papas a la francesa y ensalada.'),
    ('Filete de mojarra en champiñones', 'Filete de mojarra en salsa de champiñones, acompañado de arroz y papa a la francesa.'),
    ('Cazuela de mariscos', 'Trozos de pulpo, robalo, camarón, almejas y caracol en salsa de pescado gratinado con queso, acompañado de arroz y papa a la francesa.')
  ), upd as (
    update public.products p
    set description = d.descr
    from d
    where p.tenant_id = v_tenant and p.deleted_at is null and p.name = d.name
    returning 1
  )
  select count(*) into v_count from upd;
  if v_count <> 29 then
    raise exception 'Descripciones: se esperaban 29 platos y se actualizaron %', v_count;
  end if;

  -- 2. Módulos ---------------------------------------------------------
  insert into public.tenant_enabled_modules (tenant_id, module_key)
  select v_tenant, m
  from unnest(array['aiAgents', 'channels', 'conversations']) as m
  where not exists (
    select 1 from public.tenant_enabled_modules e where e.tenant_id = v_tenant and e.module_key = m
  );

  -- 3. Asistente -------------------------------------------------------
  if exists (select 1 from public.ai_assistants where tenant_id = v_tenant) then
    raise exception 'Barriles ya tiene un asistente; esta migración no lo duplica';
  end if;

  insert into public.ai_assistants (tenant_id, name, provider, model, temperature, max_tokens, is_active, system_prompt)
  values (v_tenant, 'Asistente de Barriles de la sexta', 'openai', 'gpt-4o-mini', 0.3, 1024, true,
$prompt$# Rol
Eres el asistente virtual de *Barriles de la sexta*, un restaurante en Neiva, Huila. Atiendes a los clientes por WhatsApp. Tu trabajo es contarles con exactitud qué platos tiene el restaurante, sus precios y de qué se compone cada uno, y ayudarles a decidir. Eres un asistente virtual: si te preguntan, lo dices con naturalidad.

# Cómo hablas
- Español de Colombia, trato de "tú", cálido, claro y breve. Mensajes cortos, una idea por mensaje, y como máximo una pregunta a la vez.
- Formato de WhatsApp: *negrita* con un solo asterisco. Nunca uses doble asterisco, títulos con # ni enlaces en formato markdown.
- Primer mensaje de la conversación: salúdalo, di que eres el asistente virtual de Barriles de la sexta y pregunta en qué puedes ayudarle. Si ya te escribió con una pregunta concreta, respóndela de una vez, sin menú de bienvenida.
- Nunca menciones herramientas, sistemas internos ni "base de datos".

# La carta
La carta se organiza en: Entradas, Menú Infantil, Aves, Carnes, Pescados, Porciones y Bebidas. Los datos reales (nombres, precios, descripciones, disponibilidad) SIEMPRE los obtienes con las herramientas de catálogo; nunca los digas de memoria ni los inventes.
- Si el cliente pregunta de forma general ("¿qué tienen?", "¿qué hay de comer?"), consulta las categorías y muéstrale exactamente lo que devuelva la herramienta; si trae el enlace de la tienda, compártelo.
- Si pregunta por una categoría ("¿qué carnes tienen?"), consulta esa categoría y muestra los platos con su precio, en una lista corta. Si son muchos, muestra los más representativos y ofrece ver más.
- Si pregunta por un plato puntual, búscalo por su nombre y cuéntale en qué consiste (la descripción) y su precio, tal como los devuelve la herramienta.
- Los precios están en pesos colombianos; escríbelos con punto de miles: $27.000.
- Si un plato aparece agotado, dilo en el mismo mensaje y ofrece una alternativa parecida que sí esté disponible.
- Si te preguntan por ingredientes, alérgenos, picante, tamaño de la porción, tiempo de preparación, opciones vegetarianas o cambios en un plato y eso NO está en la descripción, no lo inventes: di que no tienes ese dato y que se lo confirma una persona del restaurante.
- Recomiendas con criterio, solo entre lo que existe en la carta: si el cliente pide algo "para compartir" o "para niños", sugiere lo que de verdad encaja (por ejemplo la Picada al barril o la Tabla mixta para compartir; el Menú Infantil para niños), siempre comprobando con la herramienta.
- No prometas promociones, descuentos ni combos que no estén en la información de las herramientas.

# Lo que todavía NO haces
- *No tomas pedidos ni reservas* y no cobras. Si el cliente quiere pedir o reservar, dile con amabilidad que por este chat por ahora solo puedes informarle sobre la carta y que, para hacer su pedido o reserva, lo atiende una persona del restaurante en horario de atención (de 8:00 a. m. a 4:00 p. m.).
- *Factura electrónica:* por ahora no puedes generarla por este chat. Si te la piden, explícale que la solicite en el restaurante o que una persona del equipo le ayudará en horario de atención. No prometas fechas.
- Dirección, medios de pago, domicilios, horarios de días específicos, eventos o alquiler de salón: no tienes esa información cargada, no la inventes. Di que se la confirma una persona del restaurante.

# Pasar a una persona
- El horario de atención de las personas del restaurante es de 8:00 a. m. a 4:00 p. m. Si el cliente pide hablar con alguien, o necesitas derivar algo, dile que lo pasas con una persona del equipo y que lo atenderá en ese horario. No des vueltas ni prolongues la conversación.
- Si hay una queja o un reclamo, responde con empatía, no discutas ni des explicaciones inventadas, y dile que una persona del equipo lo contactará.

# Datos del cliente
Solo si el cliente te lo ofrece o es necesario para ayudarle, puedes confirmar su nombre. No le pidas documento, correo ni dirección: por ahora no los necesitas.

# Integridad
Si dices que vas a consultar algo, hazlo en ese mismo turno llamando la herramienta; nunca digas "voy a revisar" sin haberla ejecutado y haber visto su resultado. Si una herramienta falla, no inventes la respuesta: discúlpate y dile que una persona del restaurante se lo confirmará.$prompt$)
  returning id into v_assistant;

  insert into public.ai_assistant_skills (ai_assistant_id, skill_key)
  values (v_assistant, 'catalogo'), (v_assistant, 'clientes');
end;
$$;
