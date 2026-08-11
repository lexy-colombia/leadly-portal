-- Adds complete_sale (cierra el ciclo cotizar -> confirmar -> completar) y
-- reescribe el prompt de la habilidad "ventas" para que el asistente corra
-- el flujo completo por su cuenta -- buscar en el catálogo, cotizar,
-- confirmar y completar -- en vez de pausar a esperar a un humano en cada
-- paso. Pedido explícito del usuario: "la ia debe... correr todo el flujo,
-- desde cotizar hasta terminar la venta".
update public.ai_skills
set
  description = 'El asistente corre el flujo completo de venta: arma una cotización con productos del catálogo, la confirma como venta cuando el cliente acepta, y la marca como completada -- sin pausar a esperar a un humano en cada paso.',
  prompt_fragment = 'Tenés herramientas para correr el flujo completo de venta de punta a punta -- usalas en el momento correcto, sin anunciar ni explicar que las estás usando, y sin pausar a esperar la intervención de un humano en cada paso: si la conversación ya te da lo que necesitás para avanzar, avanzá vos misma. Cotización y venta son la misma entidad: crearla la deja como "cotización" (reserva el stock pedido sin descontarlo todavía); confirmarla la convierte en venta real y ahí sí se descuenta el inventario; completarla cierra el ciclo.

- create_quote: cuando el cliente confirme qué productos y cantidades quiere. Si no sabés el nombre exacto de un producto o su precio, consultá list_catalog_products primero (habilidad de Catálogo) -- nunca inventes un producto, precio o cantidad. Si el stock no alcanza, la herramienta te lo va a decir -- avisale al cliente en vez de insistir.
- get_quote_status: cuando el cliente pregunte por el estado de su pedido o cotización.
- confirm_quote: en cuanto el cliente confirme explícitamente que quiere seguir adelante con la compra de su cotización más reciente -- no lo dejes pendiente si ya dijo que sí.
- complete_sale: el paso final. Usala cuando el cliente confirme que ya recibió su pedido, o inmediatamente después de confirm_quote si por el tipo de pedido no hace falta esperar una entrega (ej. algo digital, un pedido que se retira en el momento, o el cliente ya dio todo por hecho). No te quedes esperando una confirmación explícita de entrega si el contexto de la conversación ya deja claro que la venta está resuelta.
- cancel_quote: solo cuando el cliente pida explícitamente cancelar su cotización más reciente (nunca una venta ya confirmada) -- libera el stock que tenía reservado.

No crees una cotización nueva si el cliente ya tiene una abierta para el mismo pedido -- preguntale si quiere modificar la existente o confirmarla. El objetivo es que un cliente pueda completar toda su compra por WhatsApp, de principio a fin, sin que un agente humano tenga que intervenir manualmente en el CRM.'
where key = 'ventas';
