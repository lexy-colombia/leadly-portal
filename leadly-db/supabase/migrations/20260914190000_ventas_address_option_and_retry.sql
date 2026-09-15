-- Ventas: una dirección se puede elegir por su número de opción, y un error
-- causado por el propio modelo se corrige sin volver a preguntarle al cliente.
--
-- Origen (2026-09-14, conversación real de TecnoNova, pedido 053): el
-- cliente eligió la dirección respondiendo "1", el modelo pasó "1" como
-- address_id, la herramienta lo rechazó pidiendo el id real, y el modelo le
-- volvió a listar las direcciones al cliente en vez de reintentar.
--
-- Lo que cambió en el CÓDIGO (whatsapp-ai-tools) y que este texto describe:
-- - saved_addresses trae `option` (1, 2, 3) en cada dirección.
-- - save_contact_address acepta en address_id el id real o ese número.
--
-- ⚠️ ACOPLAMIENTO GLOBAL: `ai_skills.prompt_fragment` lo reciben los
-- asistentes de TODOS los tenants. Cada reemplazo verifica que su texto de
-- origen exista y aborta la migración si no.

do $do$
declare
  v_text text;
  v_anchor text;
begin
  select prompt_fragment into v_text from public.ai_skills where key = 'ventas';

  v_anchor := 'una guardada con su `address_id` (el id que viene en saved_addresses, nunca el número con el que se la listaste al cliente), o una nueva';
  if position(v_anchor in v_text) = 0 then raise exception 'ventas: texto de address_id no encontrado'; end if;
  v_text := replace(v_text, v_anchor, 'una guardada con su `address_id` de saved_addresses, o con su número `option` si el cliente respondió con el número, o una nueva');

  v_anchor := 'Si lo tienes, confírmalo; nunca lo hagas digitar de nuevo.';
  if position(v_anchor in v_text) = 0 then raise exception 'ventas: regla de datos repetidos no encontrada'; end if;
  v_text := replace(v_text, v_anchor, 'Si lo tienes, confírmalo; nunca lo hagas digitar de nuevo. Si una herramienta te rechaza un dato por un error tuyo (un id mal pasado, un campo que faltó), corrígelo con lo que dice el error y reintenta en ese mismo turno: nunca le vuelvas a preguntar al cliente algo que ya respondió.');

  update public.ai_skills set prompt_fragment = v_text where key = 'ventas';
end
$do$;
