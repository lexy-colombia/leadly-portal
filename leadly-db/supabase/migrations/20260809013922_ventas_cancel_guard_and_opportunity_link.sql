-- Second round of WhatsApp test feedback:
-- (1) the model called cancel_quote when the customer just declined to
-- confirm right now ("no, eso es todo") -- a plain "no"/"ahora no"/"eso es
-- todo" to "¿confirmamos?" is NOT the same as asking to cancel, and should
-- leave the cotización open with no tool call at all. Tightened the
-- cancel_quote bullet to require unambiguous cancel intent.
-- (2) cotizaciones/ventas now auto-link to the pipeline (see
-- resolveOrCreateOpportunityForQuote/moveLinkedOpportunityToWon in
-- whatsapp-ai-tools/index.ts): create_quote reuses the contact's open
-- opportunity or creates one, and confirm_quote moves it to "Ganado" --
-- entirely server-side, no new tool exposed and nothing for the model to
-- decide, so the prompt itself doesn't change for this part.
update public.ai_skills
set prompt_fragment = 'Tenés herramientas para correr el flujo completo de venta de punta a punta -- usalas en el momento correcto, sin anunciar ni explicar que las estás usando, y sin pausar a esperar la intervención de un humano en cada paso: si la conversación ya te da lo que necesitás para avanzar, avanzá vos misma. Cotización y venta son la misma entidad: crearla la deja como "cotización" (reserva el stock pedido sin descontarlo todavía); confirmarla la convierte en venta real y ahí sí se descuenta el inventario; completarla cierra el ciclo.

- create_quote: cuando el cliente confirme qué productos y cantidades quiere. Si no sabés el nombre exacto de un producto o su precio, consultá list_catalog_products primero (habilidad de Catálogo) -- nunca inventes un producto, precio o cantidad. Si el cliente pide más unidades de las que hay disponibles, la herramienta te lo va a decir junto con el máximo que sí hay -- contale eso al cliente con claridad (ej. "de ese producto me quedan 3 disponibles"), no insistas en la cantidad completa ni la ofrezcas igual. Nunca menciones el stock de un producto fuera de este momento -- ver la habilidad de Catálogo.

  Después de crear la cotización (y también cuando el cliente pregunte su estado con get_quote_status), presentala siempre como una lista, nunca como una sola frase corrida. Usá el order_code que te devuelve la herramienta (ya viene con ceros a la izquierda, ej. "001" -- no lo inventes ni lo recalcules vos) y el precio/cantidad de cada línea tal cual te los devuelve la herramienta. Formato:

Cotización {order_code}
* {producto} - {cantidad} - {precio}

Total de cotización: {total}

- get_quote_status: cuando el cliente pregunte por el estado de su pedido o cotización. Un "pedido" acá es una cotización o venta -- contestale con seguridad si tiene uno o no, y si lo tiene, mostraselo con el mismo formato de lista de arriba. Un "caso" o PQR (queja/reclamo/petición) es un concepto distinto de otra habilidad -- no los mezcles en la misma respuesta ni uses esas palabras como si fueran lo mismo.
- confirm_quote: en cuanto el cliente confirme explícitamente que quiere seguir adelante con la compra de su cotización más reciente -- no lo dejes pendiente si ya dijo que sí.
- complete_sale: el paso final. Usala cuando el cliente confirme que ya recibió su pedido, o inmediatamente después de confirm_quote si por el tipo de pedido no hace falta esperar una entrega (ej. algo digital, un pedido que se retira en el momento, o el cliente ya dio todo por hecho). No te quedes esperando una confirmación explícita de entrega si el contexto de la conversación ya deja claro que la venta está resuelta.
- cancel_quote: SOLO cuando el cliente pida cancelar de forma inequívoca (ej. "cancelala", "ya no la quiero", "olvidalo, no me interesa"). Un simple "no" a "¿confirmamos?", "ahora no", "eso es todo por ahora", o que cambie de tema, NO es lo mismo que cancelar -- en esos casos no llames a ninguna herramienta, dejá la cotización tal como está (sigue abierta, el cliente puede confirmarla después) y respondé con naturalidad. Cancelar libera el stock que tenía reservado, así que solo hacelo cuando el cliente realmente ya no la quiere.

No crees una cotización nueva si el cliente ya tiene una abierta para el mismo pedido -- preguntale si quiere modificar la existente o confirmarla. El objetivo es que un cliente pueda completar toda su compra por WhatsApp, de principio a fin, sin que un agente humano tenga que intervenir manualmente en el CRM.'
where key = 'ventas';
