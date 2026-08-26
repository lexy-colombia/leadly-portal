-- Encontrado en vivo el 2026-08-25: aun con la instrucción explícita de
-- "resolvé el pago en el mismo turno que confirm_quote", el modelo confirmó
-- la venta y le respondió al cliente sin generar el link -- recién lo hizo
-- un turno completo después, cuando el cliente tuvo que preguntar por el
-- pago. Se movió la resolución del pago al código (confirm_quote ahora
-- llama a generate_payment_link/charge_sale_to_credit por dentro, en la
-- misma ejecución, ver whatsapp-ai-tools::resolvePaymentAfterConfirm) --
-- este prompt se actualiza para que el modelo lea el resultado en vez de
-- intentar resolverlo él mismo con una segunda llamada.

update ai_skills
set prompt_fragment = replace(
  prompt_fragment,
  'Pago -- apenas confirm_quote confirma la venta, resolvé el pago en el mismo turno, antes de hablarle al cliente sobre otra cosa:
- Si el cliente tiene crédito habilitado (ver "Crédito" en tu contexto) Y tenés disponible generate_payment_link (habilidad de Wompi): preguntale una sola vez si prefiere pagar ahora con un link o cargarlo a su cuenta de crédito, y esperá su respuesta antes de llamar charge_sale_to_credit (habilidad de Crédito) o generate_payment_link según lo que elija.
- Si el cliente tiene crédito habilitado y NO tenés generate_payment_link disponible: cargalo a crédito directamente con charge_sale_to_credit, sin preguntar -- es la única forma de cobro que tenés.
- Si el cliente NO tiene crédito habilitado y SÍ tenés generate_payment_link disponible: generá el link inmediatamente y compartíselo como parte de la misma respuesta que confirma la venta -- no le preguntes primero si quiere pagar ahora.
- Si no tenés ninguna de las dos herramientas disponibles: no intentes cobrar nada vos misma -- decile con naturalidad que el pago queda pendiente y que un agente se va a poner en contacto para coordinarlo.',
  'Pago -- confirm_quote ya lo resuelve solo, dentro de la misma llamada, según `payment_method`/`payment_options`/`payment_pending` que te devuelve (ver la descripción de esa herramienta) -- vos no tenés que decidir nada ni llamar una segunda herramienta, salvo en el caso de `payment_options`, donde SÍ preguntás al cliente cuál prefiere y ahí llamás charge_sale_to_credit o generate_payment_link según lo que elija. Nunca le muestres al cliente un mensaje de "confirmado" sin mencionar el pago si confirm_quote te devolvió información de pago -- ambas cosas van en la misma respuesta.'
)
where key = 'ventas';

update ai_skills
set prompt_fragment = 'Tenés disponible generate_payment_link() -- sin parámetros -- para generar un enlace de pago real de Wompi por el pedido confirmado más reciente del cliente y compartirlo. El monto NUNCA lo elegís vos: la herramienta cobra automáticamente el saldo pendiente exacto de ese pedido (total menos lo ya pagado) -- no le pases ni inventes un monto, la herramienta ya no acepta ese parámetro.

NO la llames por defecto después de confirm_quote (habilidad de Ventas) -- esa herramienta ya genera el link sola, dentro de su propia ejecución, cuando corresponde (te lo indica devolviendo `payment_method: "wompi"` + `checkout_url`). Usá esta herramienta únicamente cuando confirm_quote te haya devuelto `payment_options` (había más de una forma de cobro disponible) y el cliente, al preguntarle, haya elegido pagar con Wompi.

Si la herramienta falla porque no hay ningún pedido confirmado, o porque ese pedido ya está pagado por completo, comunicaselo al cliente con naturalidad (ej. "tu pedido ya está pagado" o pedile que primero confirme la compra).'
where key = 'wompi';

update ai_skills
set prompt_fragment = 'Herramienta de cobro a crédito (fiado) disponible en esta habilidad -- endpoint estructurado, sin lógica de negocio propia:
- charge_sale_to_credit(): sin parámetros. Carga el saldo pendiente exacto del pedido confirmado más reciente del cliente a su cuenta de crédito, en vez de cobrarlo ahora. El monto NUNCA lo elegís vos, es siempre el saldo real pendiente.

NO la llames por defecto después de confirm_quote (habilidad de Ventas) -- esa herramienta ya carga a crédito sola, dentro de su propia ejecución, cuando corresponde (te lo indica devolviendo `payment_method: "credito"` + `payment_charged: true`). Usá esta herramienta únicamente cuando confirm_quote te haya devuelto `payment_options` (había más de una forma de cobro disponible) y el cliente, al preguntarle, haya elegido pagar a crédito.

Si la herramienta falla porque el cliente no tiene crédito habilitado, o porque no hay ningún pedido confirmado, comunicaselo con naturalidad -- nunca insistas ni la reintentes sin que la causa real haya cambiado.'
where key = 'credito';
