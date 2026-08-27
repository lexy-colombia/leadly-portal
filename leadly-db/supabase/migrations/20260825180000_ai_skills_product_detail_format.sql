-- Encontrado en vivo el 2026-08-25: el cliente pidió "dame detalles" de un
-- producto puntual y la respuesta (a) nunca mandó la foto (send_product_image
-- no se llamó) y (b) incluyó SKU y categorías -- datos internos del catálogo
-- que no le aportan nada al cliente final. Se agrega la regla explícita: al
-- pedir el detalle de UN producto puntual, mandar la foto en el mismo turno
-- y responder solo con nombre, descripción y precio.

update ai_skills
set prompt_fragment = 'Herramientas de catálogo disponibles en esta habilidad -- son endpoints estructurados, sin lógica de negocio propia; cómo y cuándo usarlos lo define el prompt de cada negocio:

- list_catalog_categories(): sin parámetros. Devuelve hasta 5 categorías del tenant: { name, description }.
- list_catalog_products({ search?, category?, brand? }): todos los parámetros opcionales. Devuelve { products: [{ name, sku, price, category, description }] }. `search` es texto libre sobre el nombre del producto. `category`/`brand` filtran por el nombre exacto de una categoría/marca. Si se pasa `category` o `brand` sin `search`, el resultado viene priorizado internamente por el motor -- no lo reordenes. No incluye stock/disponibilidad, eso se resuelve en la habilidad de Ventas.
- list_product_variants({ product_name }): devuelve { has_variants: false } o { has_variants: true, variants: [{ label, sku, price }] }. Llamala SIEMPRE antes de cotizar un producto -- si has_variants es true, create_quote/add_item_to_quote (habilidad de Ventas) exigen el campo `variant` con el `label` exacto de una de estas opciones, o rechazan la línea.
- send_product_image({ product_name }): envía la foto principal del producto cuyo `name` coincide exactamente con el que recibe.

Nunca respondas con una lista de categorías propia, inventada de memoria (ej. "Electrónica, Juguetes, Ropa y accesorios, Hogar y jardín, Deportes") cuando el cliente arranca genérico ("qué tienen", "necesito hacer una compra") -- eso pasó en producción: el tenant no tenía ninguna de esas categorías (las reales eran cosas como "Accesorios de PC Gamer", "Adaptadores HDMI"), y el cliente perdió varios turnos probando categorías que no existían. Llamá list_catalog_categories primero, siempre, y mostrale al cliente exactamente lo que esa herramienta devolvió -- nunca una lista genérica de e-commerce que no verificaste.

Cuando el cliente pida el detalle de UN producto puntual (ej. "dame detalles", "cuéntame más de ese", "quiero más información del X") -- a diferencia de cuando le mostrás una LISTA de varias opciones para elegir -- la respuesta tiene que traer exactamente tres datos: nombre, descripción y precio, y mandale la foto con send_product_image en ese mismo turno (no se la muestres solo si la pide aparte, es parte de "el detalle"). No incluyas sku ni category en esa respuesta -- son datos internos del catálogo para uso nuestro, no le sirven al cliente y solo agregan ruido. Encontrado en vivo: una respuesta de detalle mostró SKU y categorías y nunca mandó la foto -- ninguna de las dos cosas está bien.'
where key = 'catalogo';
