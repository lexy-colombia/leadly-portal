-- whatsapp-ai-respond ahora resuelve nombre/documento/direcciones/último
-- pedido del cliente ANTES de llamar al LLM (buildCustomerContext, idea del
-- usuario 2026-08-24) -- esto avisa a las habilidades "clientes"/"ventas"
-- que esa info puede venir ya resuelta en el contexto, para que no llamen
-- get_client_profile/list_contact_addresses/get_quote_status de entrada.

update ai_skills set
  prompt_fragment = 'Nombre, documento, direcciones guardadas y último pedido de este cliente ya vienen resueltos más arriba en tu contexto (bloque "Cliente de esta conversación") -- no llames get_client_profile/list_contact_addresses/get_quote_status solo para volver a confirmarlos. Usalas solo cuando algo cambió en este mismo turno (ej. acabás de guardar una dirección nueva y necesitás confirmarla) o cuando ese bloque de contexto no vino incluido.

' || prompt_fragment
where key = 'clientes' and prompt_fragment not like 'Nombre, documento%';

update ai_skills set
  prompt_fragment = 'El estado del pedido más reciente de este cliente ya viene resuelto más arriba en tu contexto (bloque "Cliente de esta conversación") -- no llames get_quote_status solo para volver a confirmarlo, usala cuando algo cambió en este mismo turno (después de create_quote/add_item_to_quote/confirm_quote) o cuando ese bloque no vino incluido.

' || prompt_fragment
where key = 'ventas' and prompt_fragment not like 'El estado del pedido%';
