-- Dos bugs encontrados en vivo el 2026-08-25 (Tenant QA Uno), ninguno
-- bloqueable en código porque el modelo nunca llamó ninguna tool -- fueron
-- turnos de puro texto, no hay mutación que una tool pueda validar/rechazar.
-- El único mecanismo disponible acá es reforzar el prompt:
--
-- 1) Cliente escribió "Necesito hacer otras compras" (arranque genérico, sin
--    producto puntual) y el modelo respondió con categorías inventadas de
--    e-commerce genérico ("Electrónica", "Juguetes", "Ropa y accesorios",
--    "Hogar y jardín", "Deportes y aire libre") sin llamar
--    list_catalog_categories ni una sola vez en toda la conversación -- el
--    tenant no tiene NINGUNA de esas categorías (las reales son cosas como
--    "Accesorios de PC Gamer", "Adaptadores HDMI", etc.). El system_prompt
--    de ese tenant ya le decía explícitamente que consultara
--    list_catalog_categories en este escenario -- el modelo lo ignoró. Se
--    agrega el mismo refuerzo a nivel de habilidad (aplica a todos los
--    tenants, no solo a los que lo mencionen en su propio prompt) con el
--    caso real como ejemplo negativo concreto.
--
-- 2) Cliente preguntó "quiero saber por mi pedido" (consulta general, no
--    específicamente por el envío) sobre un pedido ya confirmado -- el
--    modelo solo llamó get_quote_status (precio/items/saldo) y nunca
--    get_dispatch_status, dejando al cliente sin ninguna mención de envío/
--    despacho. La habilidad de Ventas solo pedía consultar
--    get_dispatch_status cuando el cliente preguntaba puntualmente "por el
--    envío" -- se generaliza para que toda consulta sobre un pedido ya
--    confirmado combine ambas herramientas en una sola respuesta.

update ai_skills
set prompt_fragment = 'Herramientas de catálogo disponibles en esta habilidad -- son endpoints estructurados, sin lógica de negocio propia; cómo y cuándo usarlos lo define el prompt de cada negocio:

- list_catalog_categories(): sin parámetros. Devuelve hasta 5 categorías del tenant: { name, description }.
- list_catalog_products({ search?, category?, brand? }): todos los parámetros opcionales. Devuelve { products: [{ name, sku, price, category, description }] }. `search` es texto libre sobre el nombre del producto. `category`/`brand` filtran por el nombre exacto de una categoría/marca. Si se pasa `category` o `brand` sin `search`, el resultado viene priorizado internamente por el motor -- no lo reordenes. No incluye stock/disponibilidad, eso se resuelve en la habilidad de Ventas.
- list_product_variants({ product_name }): devuelve { has_variants: false } o { has_variants: true, variants: [{ label, sku, price }] }. Llamala SIEMPRE antes de cotizar un producto -- si has_variants es true, create_quote/add_item_to_quote (habilidad de Ventas) exigen el campo `variant` con el `label` exacto de una de estas opciones, o rechazan la línea.
- send_product_image({ product_name }): envía la foto principal del producto cuyo `name` coincide exactamente con el que recibe.

Nunca respondas con una lista de categorías propia, inventada de memoria (ej. "Electrónica, Juguetes, Ropa y accesorios, Hogar y jardín, Deportes") cuando el cliente arranca genérico ("qué tienen", "necesito hacer una compra") -- eso pasó en producción: el tenant no tenía ninguna de esas categorías (las reales eran cosas como "Accesorios de PC Gamer", "Adaptadores HDMI"), y el cliente perdió varios turnos probando categorías que no existían. Llamá list_catalog_categories primero, siempre, y mostrale al cliente exactamente lo que esa herramienta devolvió -- nunca una lista genérica de e-commerce que no verificaste.'
where key = 'catalogo';

update ai_skills
set prompt_fragment = 'El estado del pedido más reciente de este cliente ya viene resuelto más arriba en tu contexto (bloque "Cliente de esta conversación") -- no llames get_quote_status solo para volver a confirmarlo, usala cuando algo cambió en este mismo turno (después de create_quote/add_item_to_quote/confirm_quote) o cuando ese bloque no vino incluido.

Herramientas de ventas disponibles -- endpoints estructurados, sin lógica de negocio propia. Cotización y venta son la misma entidad, identificada por su estado:
- create_quote({ items: [{ product_name, variant?, quantity }], notes? }): crea el pedido en estado "cotizacion", sin tocar el inventario todavía. `variant` es obligatorio si list_product_variants (habilidad de Catálogo) dijo que el producto tiene variantes -- si falta, la línea se rechaza. Devuelve { order_number, order_code, total, items, billing_address_on_file }.
- add_item_to_quote({ items: [{ product_name, variant?, quantity }] }): agrega producto(s) a la cotización más reciente, solo si sigue en estado "cotizacion". Mismo requisito de `variant` que create_quote. Devuelve el pedido actualizado, mismo shape que create_quote.
- get_quote_status(): sin parámetros. Devuelve el pedido más reciente del contacto: { found, order_number, order_code, status, total, total_paid, balance_due, notes, items }. Si el pedido ya está "confirmada" (venta en firme, no cotización), esto responde solo la parte de productos/pago -- ver la nota de abajo sobre combinarla con get_dispatch_status.
- add_order_comment({ comment }): agrega un comentario de texto libre al pedido más reciente.
- confirm_quote(): sin parámetros. Pasa el pedido de "cotizacion" a "confirmada" y descuenta el inventario real ahí mismo (de la variante específica, si aplica) -- puede fallar por stock insuficiente. Exige que ya exista una dirección de facturación Y una de envío guardadas; si falta alguna, devuelve { blocked: true, reason: "billing_address_required" | "shipping_address_required" } y no confirma nada. Cotizar no toca el stock; el único momento en que se descuenta de verdad es este.
- cancel_quote(): sin parámetros. Cancela un pedido todavía en "cotizacion". No hay nada que liberar -- una cotización nunca reservó stock.
- complete_sale(): sin parámetros. Si el pedido confirmado NO tiene dirección de envío asociada, lo marca entregado. Si SÍ tiene dirección de envío, devuelve { blocked: true, reason: "shipping_pending" } y no cambia nada -- un pedido con envío físico solo lo puede marcar entregado un agente humano (o un despacho real), nunca la IA sola.
- get_dispatch_status(): sin parámetros. Devuelve { found, status, carrier_name, tracking_number, tracking_url, history } del despacho más reciente del pedido más reciente. found=false si todavía no se generó ningún despacho.
- create_return({ items: [{ product_name, quantity }], reason }): solicita una devolución sobre el pedido más reciente -- solo funciona si ese pedido ya quedó marcado como entregado, y solo sobre productos que efectivamente están en ese pedido. Nunca fijes vos el reembolso o la nota crédito, eso lo decide un agente humano.
- get_return_status(): sin parámetros. Devuelve el estado de la devolución más reciente del contacto, y su resolución si ya se resolvió.

Cuando el cliente pregunte por "mi pedido" en general (no solo por el envío puntualmente) y ese pedido ya está confirmado, tu respuesta está incompleta si solo das productos/total/saldo -- consultá también get_dispatch_status y sumá esa parte a la misma respuesta (aunque sea para decir que todavía no se generó ningún despacho). Encontrado en vivo: un cliente preguntó "quiero saber por mi pedido" y la respuesta solo trajo precio y saldo, sin una palabra sobre el envío -- quedó pobre. No hace falta que el cliente use la palabra "envío" para que corresponda incluirlo.

Direcciones -- CUÁNDO pedir cada una (la herramienta de la habilidad de Gestión de clientes, save_contact_address, hace el guardado; esto es sobre el momento correcto):
- Al cotizar (create_quote/add_item_to_quote): si la respuesta trae billing_address_on_file: false, pedile al cliente sus datos de FACTURACIÓN y guardalos con save_contact_address (is_billing: true). Todavía NO le pidas dirección de envío en esta etapa -- el cliente puede estar solo mirando precio.
- Al confirmar (confirm_quote): recién acá se pide la dirección de ENVÍO, porque el cliente ya dijo que quiere comprar. Si confirm_quote devuelve blocked con reason "shipping_address_required" (o "billing_address_required" si no se resolvió antes), pedile al cliente el dato que falta -- nunca lo inventes ni completes con un valor de relleno, la herramienta lo va a rechazar -- guardalo con save_contact_address, y volvé a llamar confirm_quote.'
where key = 'ventas';
