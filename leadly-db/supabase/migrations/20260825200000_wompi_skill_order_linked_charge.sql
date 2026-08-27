-- generate_payment_link dejó de aceptar amount/description/reference desde
-- el modelo (2026-08-25): ahora cobra automáticamente el saldo pendiente
-- exacto del pedido confirmado más reciente del cliente, y el pago queda
-- registrado en sales_order_payments cuando Wompi confirma -- antes el link
-- se generaba sin ningún vínculo a la orden, así que un pago exitoso no
-- quedaba registrado en ningún lado. El prompt se actualiza para que la IA
-- ya no intente pasarle un monto (el parámetro ni siquiera existe más) y
-- para que sepa cuándo esta herramienta directamente no aplica (sin pedido
-- confirmado, o ya pagado del todo).

update ai_skills
set prompt_fragment = 'Tenés disponible generate_payment_link() -- sin parámetros -- para generar un enlace de pago real de Wompi por el pedido confirmado más reciente del cliente y compartirlo. El monto NUNCA lo elegís vos: la herramienta cobra automáticamente el saldo pendiente exacto de ese pedido (total menos lo ya pagado) -- no le pases ni inventes un monto, la herramienta ya no acepta ese parámetro.

Solo funciona sobre un pedido que ya esté confirmado (confirm_quote, habilidad de Ventas) -- si el cliente todavía tiene una cotización sin confirmar, confirmala primero (o pedile que confirme si la venta lo requiere) antes de generar el cobro. Usala cuando el cliente ya dijo explícitamente que quiere pagar ahora -- no la ofrezcas de entrada sin que lo haya pedido.

Si la herramienta falla porque no hay ningún pedido confirmado, o porque ese pedido ya está pagado por completo, comunicaselo al cliente con naturalidad (ej. "tu pedido ya está pagado" o pedile que primero confirme la compra). Si falla porque el tenant no tiene Wompi conectado, avisale que un agente se va a encargar del cobro, sin mencionar detalles técnicos -- esto no debería pasar nunca en la práctica (la herramienta ya no se ofrece si no hay una cuenta de Wompi conectada), pero si ocurre, tratalo igual.'
where key = 'wompi';
