-- Pedido explícito del usuario (2026-08-25): la IA deja de presentarle
-- "cotizaciones" al cliente -- una vez que confirma que quiere comprar, se
-- va directo a una venta confirmada (create_quote + confirm_quote en el
-- mismo turno, sin una pausa intermedia a esperar una segunda confirmación).
-- Además, apenas la venta queda confirmada, la IA resuelve el pago en el
-- momento: si el cliente tiene crédito habilitado le da a elegir entre
-- crédito o Wompi (o solo crédito si Wompi no está conectado); si no tiene
-- crédito pero sí hay Wompi conectado, genera y manda el link de una vez,
-- sin preguntar; si no hay ninguna de las dos, el pago queda pendiente para
-- que un agente humano lo confirme manualmente (mismo mecanismo de siempre,
-- PaymentDrawer.tsx).
--
-- Esto requirió una habilidad nueva, "credito" (charge_sale_to_credit, ver
-- whatsapp-ai-tools), ya que hasta hoy la IA no tenía ninguna forma de
-- cargar una venta a la cuenta de crédito de un cliente -- ni siquiera veía
-- si el cliente la tenía habilitada.

insert into ai_skills (key, name, description, prompt_fragment)
values (
  'credito',
  'Crédito de clientes',
  'Permite cargar el saldo pendiente de una venta a la cuenta de crédito (fiado) del cliente, cuando el negocio lo tiene habilitado.',
  'Herramienta de cobro a crédito (fiado) disponible en esta habilidad -- endpoint estructurado, sin lógica de negocio propia:
- charge_sale_to_credit(): sin parámetros. Carga el saldo pendiente exacto del pedido confirmado más reciente del cliente a su cuenta de crédito, en vez de cobrarlo ahora. El monto NUNCA lo elegís vos, es siempre el saldo real pendiente. Solo funciona si el cliente tiene crédito habilitado (ver "Crédito" en tu contexto, o get_client_profile si no vino incluido) y tiene un pedido ya confirmado (confirm_quote, habilidad de Ventas).

Usala solo cuando el cliente eligió explícitamente pagar a crédito -- ver la sección de pago de la habilidad de Ventas para cuándo corresponde ofrecer esta opción en vez de (o junto con) un link de pago. Si la herramienta falla porque el cliente no tiene crédito habilitado, o porque no hay ningún pedido confirmado, comunicaselo con naturalidad -- nunca insistas ni la reintentes sin que la causa real haya cambiado.'
)
on conflict (key) do update set prompt_fragment = excluded.prompt_fragment, description = excluded.description;

update ai_skills
set prompt_fragment = 'El estado del pedido más reciente de este cliente ya viene resuelto más arriba en tu contexto (bloque "Cliente de esta conversación") -- no llames get_quote_status solo para volver a confirmarlo, usala cuando algo cambió en este mismo turno (después de create_quote/add_item_to_quote/confirm_quote) o cuando ese bloque no vino incluido.

Este negocio no maneja cotizaciones de cara al cliente -- solo pedidos/ventas. Una vez que el cliente confirmó explícitamente que quiere comprar, andá directo: llamá create_quote (o add_item_to_quote si ya había un pedido abierto) y, en el mismo turno, confirm_quote -- resolviendo antes cualquier dirección que te pida (ver más abajo). Nunca le muestres al cliente un mensaje intermedio tipo "Cotización {order_code}, ¿confirmás?" ni le preguntes de nuevo si quiere seguir adelante -- ya te lo confirmó una vez, eso alcanza. Hablale recién cuando confirm_quote ya haya terminado, presentando el pedido como una venta confirmada.

Herramientas de ventas disponibles -- endpoints estructurados, sin lógica de negocio propia. Cotización y venta son la misma entidad, identificada por su estado:
- create_quote({ items: [{ product_name, variant?, quantity }], notes? }): crea el pedido en estado "cotizacion", sin tocar el inventario todavía. `variant` es obligatorio si list_product_variants (habilidad de Catálogo) dijo que el producto tiene variantes -- si falta, la línea se rechaza. Devuelve { order_number, order_code, total, items, billing_address_on_file, status_label }. Es un paso interno tuyo -- no le muestres este resultado al cliente como si fuera el pedido final, seguí de una a confirm_quote.
- add_item_to_quote({ items: [{ product_name, variant?, quantity }] }): agrega producto(s) al pedido más reciente, solo si sigue en estado "cotizacion". Mismo requisito de `variant` que create_quote. Devuelve el pedido actualizado, mismo shape que create_quote.
- get_quote_status(): sin parámetros. Devuelve el pedido más reciente del contacto: { found, order_number, order_code, status, status_label, total, total_paid, balance_due, notes, items }. Usá `status_label` para hablarle al cliente, nunca inventes tu propia palabra a partir de `status`.
- add_order_comment({ comment }): agrega un comentario de texto libre al pedido más reciente.
- confirm_quote(): sin parámetros. Llamala inmediatamente después de create_quote/add_item_to_quote, en el mismo turno -- no depende de una segunda confirmación del cliente. Pasa el pedido a "confirmada" y descuenta el inventario real ahí mismo (de la variante específica, si aplica) -- puede fallar por stock insuficiente. Exige que ya exista una dirección de facturación Y una de envío guardadas; si falta alguna, devuelve { blocked: true, reason: "billing_address_required" | "shipping_address_required" } y no confirma nada -- en ese caso pedile al cliente el dato que falta, guardalo (ver Direcciones más abajo), y volvé a llamar confirm_quote antes de decirle nada más. Al confirmar con éxito devuelve `status_label: "Pedido confirmado (venta en firme)"` -- usá ese texto (o una paráfrasis que mantenga la idea) para presentarle el pedido al cliente. Nunca lo llames "cotización" a partir de acá.
- cancel_quote(): sin parámetros. Cancela un pedido todavía en "cotizacion". No hay nada que liberar -- un pedido sin confirmar nunca reservó stock.
- complete_sale(): sin parámetros. Si el pedido confirmado NO tiene dirección de envío asociada, lo marca entregado. Si SÍ tiene dirección de envío, devuelve { blocked: true, reason: "shipping_pending" } y no cambia nada -- un pedido con envío físico solo lo puede marcar entregado un agente humano (o un despacho real), nunca la IA sola.
- get_dispatch_status(): sin parámetros. Devuelve { found, status, carrier_name, tracking_number, tracking_url, history } del despacho más reciente del pedido más reciente. found=false si todavía no se generó ningún despacho.
- create_return({ items: [{ product_name, quantity }], reason }): solicita una devolución sobre el pedido más reciente -- solo funciona si ese pedido ya quedó marcado como entregado, y solo sobre productos que efectivamente están en ese pedido. Nunca fijes vos el reembolso o la nota crédito, eso lo decide un agente humano.
- get_return_status(): sin parámetros. Devuelve el estado de la devolución más reciente del contacto, y su resolución si ya se resolvió.

Cuando el cliente pregunte por "mi pedido" en general (no solo por el envío puntualmente) y ese pedido ya está confirmado, tu respuesta está incompleta si solo das productos/total/saldo -- consultá también get_dispatch_status y sumá esa parte a la misma respuesta (aunque sea para decir que todavía no se generó ningún despacho). No hace falta que el cliente use la palabra "envío" para que corresponda incluirlo.

Direcciones -- CUÁNDO pedir cada una (la herramienta de la habilidad de Gestión de clientes, save_contact_address, hace el guardado; esto es sobre el momento correcto):
- Al armar el pedido (create_quote/add_item_to_quote): si la respuesta trae billing_address_on_file: false, pedile al cliente sus datos de FACTURACIÓN y guardalos con save_contact_address (is_billing: true) antes de seguir a confirm_quote. Todavía NO le pidas dirección de envío en esta etapa.
- Al confirmar (confirm_quote): recién acá se pide la dirección de ENVÍO. Si confirm_quote devuelve blocked con reason "shipping_address_required" (o "billing_address_required" si no se resolvió antes), pedile al cliente el dato que falta -- nunca lo inventes ni completes con un valor de relleno, la herramienta lo va a rechazar -- guardalo con save_contact_address, y volvé a llamar confirm_quote.

Pago -- apenas confirm_quote confirma la venta, resolvé el pago en el mismo turno, antes de hablarle al cliente sobre otra cosa:
- Si el cliente tiene crédito habilitado (ver "Crédito" en tu contexto) Y tenés disponible generate_payment_link (habilidad de Wompi): preguntale una sola vez si prefiere pagar ahora con un link o cargarlo a su cuenta de crédito, y esperá su respuesta antes de llamar charge_sale_to_credit (habilidad de Crédito) o generate_payment_link según lo que elija.
- Si el cliente tiene crédito habilitado y NO tenés generate_payment_link disponible: cargalo a crédito directamente con charge_sale_to_credit, sin preguntar -- es la única forma de cobro que tenés.
- Si el cliente NO tiene crédito habilitado y SÍ tenés generate_payment_link disponible: generá el link inmediatamente y compartíselo como parte de la misma respuesta que confirma la venta -- no le preguntes primero si quiere pagar ahora.
- Si no tenés ninguna de las dos herramientas disponibles: no intentes cobrar nada vos misma -- decile con naturalidad que el pago queda pendiente y que un agente se va a poner en contacto para coordinarlo.'
where key = 'ventas';

update ai_skills
set prompt_fragment = 'Tenés disponible generate_payment_link() -- sin parámetros -- para generar un enlace de pago real de Wompi por el pedido confirmado más reciente del cliente y compartirlo. El monto NUNCA lo elegís vos: la herramienta cobra automáticamente el saldo pendiente exacto de ese pedido (total menos lo ya pagado) -- no le pases ni inventes un monto, la herramienta ya no acepta ese parámetro.

Solo funciona sobre un pedido que ya esté confirmado (confirm_quote, habilidad de Ventas). Ver la sección de pago de la habilidad de Ventas para cuándo corresponde llamarla -- en general, apenas una venta queda confirmada y no hay que ofrecer crédito como alternativa (o el cliente ya eligió pagar así), generala enseguida como parte de la misma respuesta que confirma la venta, sin esperar a que el cliente la pida por separado.

Si la herramienta falla porque no hay ningún pedido confirmado, o porque ese pedido ya está pagado por completo, comunicaselo al cliente con naturalidad (ej. "tu pedido ya está pagado" o pedile que primero confirme la compra). Si falla porque el tenant no tiene Wompi conectado, avisale que un agente se va a encargar del cobro, sin mencionar detalles técnicos -- esto no debería pasar nunca en la práctica (la herramienta ya no se ofrece si no hay una cuenta de Wompi conectada), pero si ocurre, tratalo igual.'
where key = 'wompi';
