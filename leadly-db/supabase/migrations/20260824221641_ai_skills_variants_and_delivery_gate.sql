-- Ajustes al catálogo de habilidades encontrados probando en vivo el
-- 2026-08-24: los productos con variantes (color/talla) se vendían sin
-- preguntar cuál, y complete_sale marcaba "entregado" apenas se guardaba
-- una dirección de envío, sin ningún despacho real detrás. Ver
-- 20260824200645_ai_skills_clientes_and_ventas_expansion.sql para el
-- contexto de esta misma migración incremental sobre "catalogo"/"ventas".

update public.ai_skills set
  prompt_fragment = 'Herramientas de catálogo disponibles en esta habilidad -- son endpoints estructurados, sin lógica de negocio propia; cómo y cuándo usarlos lo define el prompt de cada negocio:

- list_catalog_categories(): sin parámetros. Devuelve hasta 5 categorías del tenant: { name, description }.
- list_catalog_products({ search?, category?, brand? }): todos los parámetros opcionales. Devuelve { products: [{ name, sku, price, category, description }] }. `search` es texto libre sobre el nombre del producto. `category`/`brand` filtran por el nombre exacto de una categoría/marca. Si se pasa `category` o `brand` sin `search`, el resultado viene priorizado internamente por el motor -- no lo reordenes. No incluye stock/disponibilidad, eso se resuelve en la habilidad de Ventas.
- list_product_variants({ product_name }): devuelve { has_variants: false } o { has_variants: true, variants: [{ label, sku, price }] }. Llamala SIEMPRE antes de cotizar un producto -- si has_variants es true, create_quote/add_item_to_quote (habilidad de Ventas) exigen el campo `variant` con el `label` exacto de una de estas opciones, o rechazan la línea.
- send_product_image({ product_name }): envía la foto principal del producto cuyo `name` coincide exactamente con el que recibe.'
where key = 'catalogo';

update public.ai_skills set
  prompt_fragment = 'Herramientas de ventas disponibles -- endpoints estructurados, sin lógica de negocio propia. Cotización y venta son la misma entidad, identificada por su estado:
- create_quote({ items: [{ product_name, variant?, quantity }], notes? }): crea el pedido en estado "cotizacion" y reserva el stock pedido. `variant` es obligatorio si list_product_variants (habilidad de Catálogo) dijo que el producto tiene variantes -- si falta, la línea se rechaza. Devuelve { order_number, order_code, total, items }.
- add_item_to_quote({ items: [{ product_name, variant?, quantity }] }): agrega producto(s) a la cotización más reciente, solo si sigue en estado "cotizacion". Mismo requisito de `variant` que create_quote. Devuelve el pedido actualizado, mismo shape que create_quote.
- get_quote_status(): sin parámetros. Devuelve el pedido más reciente del contacto: { found, order_number, order_code, status, total, total_paid, balance_due, notes, items }.
- add_order_comment({ comment }): agrega un comentario de texto libre al pedido más reciente.
- confirm_quote(): sin parámetros. Pasa el pedido de "cotizacion" a "confirmada" y descuenta el inventario real (de la variante específica, si aplica); puede fallar por stock insuficiente.
- cancel_quote(): sin parámetros. Cancela un pedido todavía en "cotizacion" y libera el stock reservado.
- complete_sale(): sin parámetros. Si el pedido confirmado NO tiene dirección de envío asociada, lo marca entregado. Si SÍ tiene dirección de envío, devuelve { blocked: true, reason: "shipping_pending" } y no cambia nada -- un pedido con envío físico solo lo puede marcar entregado un agente humano (o un despacho real), nunca la IA sola.
- get_dispatch_status(): sin parámetros. Devuelve { found, status, carrier_name, tracking_number, tracking_url, history } del despacho más reciente del pedido más reciente. found=false si todavía no se generó ningún despacho.
- create_return({ items: [{ product_name, quantity }], reason }): solicita una devolución sobre el pedido más reciente -- solo funciona si ese pedido está "entregada", y solo sobre productos que efectivamente están en ese pedido. Nunca fijes vos el reembolso o la nota crédito, eso lo decide un agente humano.
- get_return_status(): sin parámetros. Devuelve el estado de la devolución más reciente del contacto, y su resolución si ya se resolvió.

Direcciones de envío/facturación NO están acá -- son parte de la habilidad de Gestión de clientes (list_contact_addresses/save_contact_address).'
where key = 'ventas';
