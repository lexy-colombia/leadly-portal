-- Catálogo: cada producto trae su enlace en la tienda pública (`product_url`).
--
-- Pedido del usuario (2026-09-14): "que en los productos retorne la url del
-- producto en el catálogo". Hasta acá los textos PROHIBÍAN compartir links a
-- productos sueltos (solo existía el enlace general de la tienda).
--
-- Lo que cambió en el CÓDIGO (whatsapp-ai-tools) y que este texto describe:
-- - list_catalog_products devuelve `product_url` por producto y
--   list_product_variants lo devuelve a nivel del producto, solo si la tienda
--   está activa y el producto está publicado (is_visible_in_catalog).
-- - El pie de la foto del producto agrega "Ver en la tienda: <enlace>".
--
-- ⚠️ ACOPLAMIENTO GLOBAL: `ai_skills.prompt_fragment` lo reciben los
-- asistentes de TODOS los tenants. Si cambia cuándo viene `product_url`, o
-- el caption deja de traer el enlace, este texto se actualiza en la misma
-- ronda. Cada reemplazo verifica que su texto de origen exista y aborta la
-- migración si no.

do $do$
declare
  v_text text;
  procedure_anchor text;

begin
  -- Fragmento global de catálogo.
  select prompt_fragment into v_text from public.ai_skills where key = 'catalogo';

  procedure_anchor := 'Devuelve { products: [{ name, sku, price, categories, description, in_stock }] }.';
  if position(procedure_anchor in v_text) = 0 then raise exception 'catalogo: firma de list_catalog_products no encontrada'; end if;
  v_text := replace(v_text, procedure_anchor, 'Devuelve { products: [{ name, sku, price, categories, description, in_stock, product_url? }] }.');

  procedure_anchor := 'devuelve { has_variants: false, in_stock } o { has_variants: true, variants: [{ label, sku, price, in_stock }] }.';
  if position(procedure_anchor in v_text) = 0 then raise exception 'catalogo: firma de list_product_variants no encontrada'; end if;
  v_text := replace(v_text, procedure_anchor, 'devuelve { has_variants: false, in_stock, product_url? } o { has_variants: true, variants: [{ label, sku, price, in_stock }], product_url? }.');

  procedure_anchor := 'Nunca armes ni modifiques ese enlace, ni lo reemplaces por links a productos sueltos. Si no viene, el negocio no tiene tienda: no menciones ninguna.';
  if position(procedure_anchor in v_text) = 0 then raise exception 'catalogo: párrafo de storefront_url no encontrado'; end if;
  v_text := replace(v_text, procedure_anchor, $t$Nunca armes ni modifiques ese enlace. Si no viene, el negocio no tiene tienda: no menciones ninguna.

Enlace de cada producto -- `product_url`: cada producto de list_catalog_products, y el producto de list_product_variants, lo traen cuando está publicado en la tienda. Compártelo cuando el cliente se interesa en un producto puntual (lo eligió de una lista, pidió detalles o quiere verlo) y la foto no salió con su ficha, para que lo vea y lo compre ahí. En una lista de varias opciones basta con el enlace general de la tienda: no llenes el mensaje de enlaces. Úsalo siempre tal cual; si un producto no lo trae, no está publicado: nunca inventes un enlace.$t$);

  procedure_anchor := 'y la descripción. Es un solo mensaje';
  if position(procedure_anchor in v_text) = 0 then raise exception 'catalogo: descripción del caption no encontrada'; end if;
  v_text := replace(v_text, procedure_anchor, ', la descripción y el enlace del producto en la tienda (si está publicado). Es un solo mensaje');

  procedure_anchor := 'NO repite nombre/precio/referencias/descripción';
  if position(procedure_anchor in v_text) = 0 then raise exception 'catalogo: regla de no repetir la ficha no encontrada'; end if;
  v_text := replace(v_text, procedure_anchor, 'NO repite nombre/precio/referencias/descripción/enlace');

  update public.ai_skills set prompt_fragment = v_text where key = 'catalogo';

  -- Prompt de TecnoNova.
  select system_prompt into v_text from public.ai_assistants where id = 'a942753b-6ab0-4baa-b750-ac94faf749f7';

  procedure_anchor := 'Ese enlace es el único que puedes compartir, tal cual lo devuelve la herramienta -- nunca armes otro ni links a productos sueltos.';
  if position(procedure_anchor in v_text) = 0 then raise exception 'tecnonova: regla de enlaces no encontrada'; end if;
  v_text := replace(v_text, procedure_anchor, 'Comparte los enlaces siempre tal cual los devuelven las herramientas (`storefront_url` para la tienda, `product_url` para cada producto) -- nunca armes uno tú.');

  procedure_anchor := 'la foto sale sola con su ficha en el pie: nombre, precio, referencias disponibles y descripción.';
  if position(procedure_anchor in v_text) = 0 then raise exception 'tecnonova: ficha de la foto no encontrada'; end if;
  v_text := replace(v_text, procedure_anchor, E'la foto sale sola con su ficha en el pie: nombre, precio, referencias disponibles, descripción y el enlace del producto en la tienda.');

  procedure_anchor := E'- Si `image_sent` viene en false, dile con naturalidad que no tienes foto cargada de ese producto y ahí sí dale nombre, precio y descripción en texto.';
  if position(procedure_anchor in v_text) = 0 then raise exception 'tecnonova: regla de image_sent no encontrada'; end if;
  v_text := replace(v_text, procedure_anchor, E'- Si `image_sent` viene en false, dile con naturalidad que no tienes foto cargada de ese producto y ahí sí dale nombre, precio, descripción y su `product_url` en texto.\n- Cuando el cliente elige un producto de una lista o pide verlo, compártele su `product_url` para que lo vea en la tienda.');

  update public.ai_assistants set system_prompt = v_text, updated_at = now() where id = 'a942753b-6ab0-4baa-b750-ac94faf749f7';
end
$do$;
