-- Catálogo: el enlace de la tienda pública lo entrega la herramienta
-- (`storefront_url`), no el prompt de cada negocio.
--
-- Origen (2026-09-14, conversaciones reales de TecnoNova): ante "me podrías
-- dar el catálogo" y "qué tienen", la IA respondió con las 5 categorías y
-- nunca compartió la tienda, aunque el system_prompt tenía el enlace escrito
-- con la instrucción de compartirlo. Pedido del usuario: "ahora no me
-- muestra el link del catálogo".
--
-- Lo que cambió en el CÓDIGO y que este texto describe:
-- - list_catalog_categories devuelve `storefront_url` si el tenant tiene la
--   tienda activa; list_catalog_products también, con category/brand o con
--   una búsqueda que no deja un único producto.
-- - whatsapp-ai-respond agrega el enlace al final de la respuesta si una
--   herramienta lo devolvió en ese turno y el modelo lo omitió.
-- - save_contact_address rechaza un address_id que no sea un id real.
--
-- ⚠️ ACOPLAMIENTO GLOBAL: `ai_skills.prompt_fragment` lo reciben los
-- asistentes de TODOS los tenants. Hoy `catalogo` lo tienen TecnoNova (con
-- tienda activa) y Universidad del Norte Digital (sin tienda: no le llega
-- ningún `storefront_url`, así que para ese asistente no cambia nada).
--
-- Cada reemplazo verifica que el texto de origen exista y aborta la
-- migración si no: un replace() que no encuentra su texto no falla y deja el
-- prompt desalineado sin avisar.

do $do$
declare
  v_fragment text;
  v_prompt text;
  v_anchor text;
begin
  -- Fragmento global de catálogo.
  select prompt_fragment into v_fragment from public.ai_skills where key = 'catalogo';
  v_anchor := E'\n\nDisponibilidad -- se dice en la consulta, nunca al final:';
  if position(v_anchor in v_fragment) = 0 then
    raise exception 'catalogo: no se encontró el ancla "Disponibilidad"';
  end if;
  v_fragment := replace(v_fragment, v_anchor, $t$

Tienda en línea -- `storefront_url`: list_catalog_categories siempre, y list_catalog_products con category/brand o con una búsqueda que no deja un único producto, lo traen cuando el negocio tiene tienda pública activa. Cuando venga, inclúyelo tal cual en ese mismo mensaje -- sobre todo si el cliente pidió el catálogo, preguntó qué hay o está entre varias opciones: es la forma más rápida de que vea todo. Nunca armes ni modifiques ese enlace, ni lo reemplaces por links a productos sueltos. Si no viene, el negocio no tiene tienda: no menciones ninguna.$t$ || v_anchor);
  update public.ai_skills set prompt_fragment = v_fragment where key = 'catalogo';

  -- Fragmento global de ventas: address_id real, no el número de la lista.
  select prompt_fragment into v_fragment from public.ai_skills where key = 'ventas';
  v_anchor := 'una guardada con su `address_id`, o una nueva';
  if position(v_anchor in v_fragment) = 0 then
    raise exception 'ventas: no se encontró el texto de address_id';
  end if;
  v_fragment := replace(v_fragment, v_anchor, 'una guardada con su `address_id` (el id que viene en saved_addresses, nunca el número con el que se la listaste al cliente), o una nueva');
  update public.ai_skills set prompt_fragment = v_fragment where key = 'ventas';

  -- Prompt de TecnoNova: deja de tener el enlace escrito a mano.
  select system_prompt into v_prompt from public.ai_assistants where id = 'a942753b-6ab0-4baa-b750-ac94faf749f7';
  v_anchor := 'Si el cliente pide algo genérico ("qué tienen", "algo para regalar", "audio")';
  if position(v_anchor in v_prompt) = 0 then
    raise exception 'tecnonova: no se encontró el texto de pedido genérico';
  end if;
  v_prompt := replace(v_prompt, v_anchor, 'Si el cliente pide el catálogo o algo genérico ("qué tienen", "algo para regalar", "audio")');

  v_anchor := E'2. Compártele nuestra tienda para que la recorra él mismo: https://leadly.lexycolombia.com/tienda/tecno-nova\nEse enlace es el único que puedes compartir -- nunca armes otro ni links a productos sueltos.';
  if position(v_anchor in v_prompt) = 0 then
    raise exception 'tecnonova: no se encontró el enlace de la tienda';
  end if;
  v_prompt := replace(v_prompt, v_anchor, E'2. Compártele el enlace de nuestra tienda para que la recorra él mismo: es el `storefront_url` que traen list_catalog_categories y list_catalog_products. Va siempre que pida el catálogo o pregunte qué hay.\nEse enlace es el único que puedes compartir, tal cual lo devuelve la herramienta -- nunca armes otro ni links a productos sueltos.');
  update public.ai_assistants set system_prompt = v_prompt, updated_at = now() where id = 'a942753b-6ab0-4baa-b750-ac94faf749f7';
end
$do$;
