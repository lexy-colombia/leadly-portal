-- Moyano (Faiver): el asistente entiende las respuestas a la plantilla "actualizar datos".
-- SOLO datos: UPDATE del system_prompt de UN asistente existente (id + tenant). Sin INSERT, sin tablas ni
-- filas nuevas, no toca ai_skills (global), codigo ni otros asistentes.
-- Unico punto de cambio: anade la seccion "## 5. Actualizar datos de contacto" antes de "# Lo que NO puedes hacer".
-- La linea "No uses flag_interest_for_followup: no aplica a este negocio." queda INTACTA (la seccion no usa
-- esa herramienta). Las unicas escrituras que la seccion permite son update_client_profile sobre la fila de
-- clients ya existente: el correo, y do_not_contact=true (etiqueta constante 'no contactar' en clients.tags,
-- aplicada por el servidor; requiere el codigo de whatsapp-ai-tools desplegado ANTES -- ver reporte). Aborta (raise exception, sin escribir) si falta o se repite alguna frase de origen:
-- el replace() silencioso que no coincide esta prohibido. Idempotente.
do $mig$
declare
  c_assistant constant uuid := '9ce9415a-4f24-4092-ac96-6e311c48df68';
  c_tenant    constant uuid := '7419c825-4d72-45af-bf40-73375eed9f9c';
  c_header    constant text := '## 5. Actualizar datos de contacto (respuesta a la plantilla de la administración)';
  c_anchor    constant text := E'\n# Lo que NO puedes hacer\n';
  c_keep_line constant text := '- No uses flag_interest_for_followup: no aplica a este negocio.';
  c_first     constant text := 'Primer mensaje de la conversación';
  c_first2    constant text := 'Si ya te escribió con una petición concreta, atiéndela de una vez, sin menú.';
  c_datos     constant text := 'Puedes confirmar o actualizar nombre, documento y correo del cliente con update_client_profile solo si él te lo da o te lo pide.';
  c_section   constant text := $sec$## 5. Actualizar datos de contacto (respuesta a la plantilla de la administración)
La administración envía una plantilla a los propietarios para confirmar sus datos de contacto (para enviarles avisos y el estado de cuenta de su unidad). Trae tres botones y su respuesta te llega como un mensaje del cliente con ese texto: "Actualizar mis datos", "Más tarde" o "No deseo recibir mensajes".
- Esta sección aplica cuando el mensaje del cliente es uno de esos tres textos (sin distinguir mayúsculas ni tildes, tolerando pequeñas variantes), o cuando dice con otras palabras que quiere actualizar o cambiar su correo, que sus datos están desactualizados o que no quiere recibir mensajes.
- Esta sección tiene prioridad sobre la regla de "Primer mensaje de la conversación": si el primer mensaje es una respuesta a la plantilla, no saludes con el menú genérico ni preguntes "en qué puedo ayudarte".
- *Actualizar mis datos*: consulta get_client_profile. Salúdalo por su nombre si lo tienes, dile en una frase para qué es (avisos y estado de cuenta de su unidad) y pídele SOLO su correo electrónico, en una sola pregunta. Si ya hay un correo guardado, menciónalo enmascarado (las dos primeras letras, tres puntos "•••" y el dominio, por ejemplo "ju•••@gmail.com") y pregúntale cuál es su correo actual.
  - Cuando te lo escriba, llama update_client_profile con el campo email (y full_name solo si él lo ofrece). Confírmale el correo guardado únicamente si la herramienta confirmó updated=true.
  - Si lo que escribió no parece un correo válido (sin @ o sin dominio), pídelo de nuevo sin guardar nada.
  - Al terminar, agradécele y pregunta si necesita algo más.
- No pidas un teléfono: el número de WhatsApp con el que escribe ya está asociado a su unidad. Si él ofrece otro número, no lo captures ni lo guardes: dile con honestidad que por ahora solo se actualiza el correo y que el número con el que escribe ya está asociado a su unidad.
- *Más tarde*: responde breve y cordial, dile que puede escribir "actualizar mis datos" cuando quiera. No uses ninguna herramienta y no insistas.
- *No deseo recibir mensajes*: llama UNA sola vez update_client_profile con do_not_contact=true, sin ningún otro campo y sin pedir ni guardar ningún dato. Solo si la herramienta confirma do_not_contact=true, discúlpate en una frase, dile que su solicitud quedó registrada y que la administración la tendrá en cuenta, y despídete. Si la herramienta falla, discúlpate y dile que la administración lo atenderá. PROHIBIDO prometer que "no le escribirán más", que "no recibirá más mensajes" o algo equivalente. No insistas ni vuelvas a llamarla.
- Si dice que NO es el propietario o que el número es de otra persona: agradécele y discúlpate. No des ni confirmes ningún dato de la cuenta y no uses ninguna herramienta.
- Nunca inventes un correo, nunca guardes uno que el cliente no haya escrito y nunca cambies el documento ni el nombre si no lo pide.
$sec$;
  v_old text;
  v_new text;
  v_cnt int;
  v_phrase text;
begin
  select system_prompt into v_old
  from public.ai_assistants
  where id = c_assistant and tenant_id = c_tenant
  for update;
  if not found then
    raise exception 'moyano_prompt: no existe el asistente % del tenant %', c_assistant, c_tenant;
  end if;
  if v_old is null then
    raise exception 'moyano_prompt: system_prompt nulo';
  end if;

  -- Idempotencia: seccion completa ya presente -> nada que hacer.
  if position(c_section in v_old) > 0 then
    raise notice 'moyano_prompt: ya aplicada, sin cambios';
    return;
  end if;
  -- Cabecera presente pero seccion distinta/incompleta: no adivinar.
  if position(c_header in v_old) > 0 then
    raise exception 'moyano_prompt: la seccion 5 existe de forma incompleta o distinta; revisar a mano';
  end if;

  -- Frases de origen: cada una EXACTAMENTE una vez (incluye la linea que debe quedar intacta).
  foreach v_phrase in array array[c_keep_line, c_anchor, c_first, c_first2, c_datos] loop
    v_cnt := (length(v_old) - length(replace(v_old, v_phrase, ''))) / length(v_phrase);
    if v_cnt <> 1 then
      raise exception 'moyano_prompt: la frase de origen aparece % veces (se esperaba 1): %', v_cnt, left(v_phrase, 60);
    end if;
  end loop;

  v_new := replace(v_old, c_anchor, E'\n' || c_section || E'\n# Lo que NO puedes hacer\n');

  -- Verificaciones post-cambio.
  if length(v_new) <> length(v_old) + length(E'\n' || c_section || E'\n# Lo que NO puedes hacer\n') - length(c_anchor) then
    raise exception 'moyano_prompt: longitud inesperada';
  end if;
  if position(c_section || E'\n# Lo que NO puedes hacer' in v_new) = 0 then
    raise exception 'moyano_prompt: la seccion no quedo justo antes de "Lo que NO puedes hacer"';
  end if;
  if position(c_keep_line in v_new) = 0 then
    raise exception 'moyano_prompt: se perdio la linea que debia quedar intacta';
  end if;
  if position('flag_interest' in c_section) > 0 then
    raise exception 'moyano_prompt: la seccion no puede nombrar flag_interest_for_followup';
  end if;

  update public.ai_assistants
     set system_prompt = v_new
   where id = c_assistant and tenant_id = c_tenant;
  raise notice 'moyano_prompt: aplicada (% -> % caracteres)', length(v_old), length(v_new);
end
$mig$;
