-- Habilidad nueva para send_cart_link (whatsapp-ai-tools/_shared/aiTools.ts).
-- Deliberadamente separada de "ventas" (no un tool más de esa habilidad):
-- todo tenant que vende hoy ya tiene "ventas" activa, así que si send_cart_link
-- viviera ahí quedaría automáticamente disponible para todos apenas se
-- desplegara whatsapp-ai-respond -- y la página pública /carrito/:token
-- todavía no existe en el frontend, así que el link que mandaría sería un
-- 404 real para un cliente real. Como habilidad propia, arranca inerte para
-- todo el mundo (nadie tiene una fila en ai_assistant_skills todavía) hasta
-- que se habilite a propósito por asistente una vez la página exista.
insert into ai_skills (key, name, description, prompt_fragment)
values (
  'carrito',
  'Carrito de compra (link público)',
  'Permite mandarle al cliente un link a una página pública donde puede revisar/editar su cotización, cargar sus direcciones y terminar la compra (pago incluido) por su cuenta, en vez de que la IA cierre la venta directamente en el chat.',
  'Tenés disponible send_cart_link() -- sin parámetros -- para mandarle al cliente un link a una página de carrito con su cotización más reciente ya cargada. La herramienta arma el link y lo envía por WhatsApp ella misma en la misma llamada -- no tenés que pegar la URL vos ni avisar nada más, solo confirmá con naturalidad que se lo mandaste.

Es una alternativa a confirm_quote (habilidad de Ventas), no la reemplaza: usá send_cart_link cuando el pedido tiene varios ítems, un monto considerable, o el cliente mismo pide revisar/editar el carrito antes de pagar -- son los casos en los que conviene que lo repase visualmente en vez de confiar en que vos leíste bien todo por chat. Para una compra simple de un solo producto que el cliente ya confirmó verbalmente, seguí cerrándola vos misma con confirm_quote como siempre -- no le agregues un paso extra si no hace falta.

Solo funciona sobre una cotización todavía en estado "cotizacion" -- si ya no hay ninguna pendiente, la herramienta falla y se lo comunicás con naturalidad.'
)
on conflict (key) do nothing;
