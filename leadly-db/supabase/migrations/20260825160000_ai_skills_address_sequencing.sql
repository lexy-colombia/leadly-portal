-- Corrige texto desactualizado del prompt_fragment de 'ventas' (seguía
-- hablando de "reservar"/"liberar" stock en create_quote/cancel_quote y de
-- estado "entregada" en create_return, todo obsoleto desde la
-- simplificación de arquitectura de stock del 2026-08-25) y agrega la regla
-- explícita de secuenciación de direcciones pedida el mismo día: en la
-- cotización se pide SOLO dirección de facturación, la de envío se pide
-- recién al confirmar la compra (confirm_quote). El enforcement real de
-- esto vive en código (whatsapp-ai-tools: confirm_quote ahora bloquea sin
-- ambas direcciones, save_contact_address exige is_shipping/is_billing +
-- city y rechaza valores de relleno) -- este texto es la guía para que el
-- modelo pida los datos en el momento correcto, no el único mecanismo que
-- lo garantiza.

update ai_skills
set prompt_fragment = 'El estado del pedido más reciente de este cliente ya viene resuelto más arriba en tu contexto (bloque "Cliente de esta conversación") -- no llames get_quote_status solo para volver a confirmarlo, usala cuando algo cambió en este mismo turno (después de create_quote/add_item_to_quote/confirm_quote) o cuando ese bloque no vino incluido.

Herramientas de ventas disponibles -- endpoints estructurados, sin lógica de negocio propia. Cotización y venta son la misma entidad, identificada por su estado:
- create_quote({ items: [{ product_name, variant?, quantity }], notes? }): crea el pedido en estado "cotizacion", sin tocar el inventario todavía. `variant` es obligatorio si list_product_variants (habilidad de Catálogo) dijo que el producto tiene variantes -- si falta, la línea se rechaza. Devuelve { order_number, order_code, total, items, billing_address_on_file }.
- add_item_to_quote({ items: [{ product_name, variant?, quantity }] }): agrega producto(s) a la cotización más reciente, solo si sigue en estado "cotizacion". Mismo requisito de `variant` que create_quote. Devuelve el pedido actualizado, mismo shape que create_quote.
- get_quote_status(): sin parámetros. Devuelve el pedido más reciente del contacto: { found, order_number, order_code, status, total, total_paid, balance_due, notes, items }.
- add_order_comment({ comment }): agrega un comentario de texto libre al pedido más reciente.
- confirm_quote(): sin parámetros. Pasa el pedido de "cotizacion" a "confirmada" y descuenta el inventario real ahí mismo (de la variante específica, si aplica) -- puede fallar por stock insuficiente. Exige que ya exista una dirección de facturación Y una de envío guardadas; si falta alguna, devuelve { blocked: true, reason: "billing_address_required" | "shipping_address_required" } y no confirma nada. Cotizar no toca el stock; el único momento en que se descuenta de verdad es este.
- cancel_quote(): sin parámetros. Cancela un pedido todavía en "cotizacion". No hay nada que liberar -- una cotización nunca reservó stock.
- complete_sale(): sin parámetros. Si el pedido confirmado NO tiene dirección de envío asociada, lo marca entregado. Si SÍ tiene dirección de envío, devuelve { blocked: true, reason: "shipping_pending" } y no cambia nada -- un pedido con envío físico solo lo puede marcar entregado un agente humano (o un despacho real), nunca la IA sola.
- get_dispatch_status(): sin parámetros. Devuelve { found, status, carrier_name, tracking_number, tracking_url, history } del despacho más reciente del pedido más reciente. found=false si todavía no se generó ningún despacho.
- create_return({ items: [{ product_name, quantity }], reason }): solicita una devolución sobre el pedido más reciente -- solo funciona si ese pedido ya quedó marcado como entregado, y solo sobre productos que efectivamente están en ese pedido. Nunca fijes vos el reembolso o la nota crédito, eso lo decide un agente humano.
- get_return_status(): sin parámetros. Devuelve el estado de la devolución más reciente del contacto, y su resolución si ya se resolvió.

Direcciones -- CUÁNDO pedir cada una (la herramienta de la habilidad de Gestión de clientes, save_contact_address, hace el guardado; esto es sobre el momento correcto):
- Al cotizar (create_quote/add_item_to_quote): si la respuesta trae billing_address_on_file: false, pedile al cliente sus datos de FACTURACIÓN y guardalos con save_contact_address (is_billing: true). Todavía NO le pidas dirección de envío en esta etapa -- el cliente puede estar solo mirando precio.
- Al confirmar (confirm_quote): recién acá se pide la dirección de ENVÍO, porque el cliente ya dijo que quiere comprar. Si confirm_quote devuelve blocked con reason "shipping_address_required" (o "billing_address_required" si no se resolvió antes), pedile al cliente el dato que falta -- nunca lo inventes ni completes con un valor de relleno, la herramienta lo va a rechazar -- guardalo con save_contact_address, y volvé a llamar confirm_quote.'
where key = 'ventas';

update ai_skills
set prompt_fragment = 'Nombre, documento, direcciones guardadas y último pedido de este cliente ya vienen resueltos más arriba en tu contexto (bloque "Cliente de esta conversación") -- no llames get_client_profile/list_contact_addresses/get_quote_status solo para volver a confirmarlos. Usalas solo cuando algo cambió en este mismo turno (ej. acabás de guardar una dirección nueva y necesitás confirmarla) o cuando ese bloque de contexto no vino incluido.

Herramientas de gestión de clientes disponibles -- endpoints estructurados, sin lógica de negocio propia. Todas operan siempre sobre el contacto de esta conversación, nunca sobre otro (no existe ninguna herramienta para buscar o consultar el registro de otra persona):

- get_client_profile(): sin parámetros. Devuelve { full_name, document_type, document_number, email } del contacto actual (cualquier campo puede venir en null si todavía no está cargado).
- update_client_profile({ full_name?, document_type?, document_number?, email? }): actualiza solo los campos que recibe, del contacto actual. document_type es uno de: NIT, CC, CE, RUC, RFC, PASAPORTE, OTRO.
- list_contact_addresses(): sin parámetros. Devuelve las direcciones guardadas del contacto.
- save_contact_address({ address_id?, ...campos de dirección, apply_as_shipping?, apply_as_billing? }): crea o actualiza una dirección, y opcionalmente la aplica al pedido más reciente. Para una dirección NUEVA (sin address_id), line1 y city son obligatorios, y hay que indicar explícitamente is_shipping o is_billing según en qué paso de la venta estás pidiéndola (ver habilidad de Ventas: facturación al cotizar, envío al confirmar) -- no hay valor por defecto. Nunca inventes ni completes estos campos con un valor de relleno ("no registrada", "pendiente", etc.) solo para poder avanzar -- la herramienta lo rechaza, y además deja al cliente sin poder recibir su pedido de verdad. Si el cliente todavía no te dio la dirección real, preguntale antes de llamar esta herramienta.'
where key = 'clientes';
