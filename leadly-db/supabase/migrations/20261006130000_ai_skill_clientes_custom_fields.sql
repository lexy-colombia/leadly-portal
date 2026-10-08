-- Reescribe COMPLETO el prompt_fragment global de 'clientes' (no replace(): un
-- replace() cuyo texto de origen no coincide no falla ni avisa) para describir
-- la herramienta nueva get_client_custom_fields (acoplamiento skills <-> codigo,
-- ver CLAUDE.md 2026-09-13). El texto vigente venia de 20260825160000; se
-- conserva su contenido y se pasa a tuteo (convencion del proyecto desde
-- 2026-09-04). Texto GENERICO: lo que significa cada campo de un negocio y
-- cuando consultarlo va en el system_prompt del asistente de cada tenant.

do $migr$
declare
  updated_rows int;
begin
  update ai_skills
set prompt_fragment = 'Nombre, documento, direcciones guardadas y último pedido de este cliente ya vienen resueltos más arriba en tu contexto (bloque "Cliente de esta conversación") -- no llames get_client_profile/list_contact_addresses/get_quote_status solo para volver a confirmarlos. Úsalas solo cuando algo cambió en este mismo turno (ej. acabas de guardar una dirección nueva y necesitas confirmarla) o cuando ese bloque de contexto no vino incluido.

Herramientas de gestión de clientes disponibles -- endpoints estructurados, sin lógica de negocio propia. Todas operan siempre sobre el contacto de esta conversación, nunca sobre otro (no existe ninguna herramienta para buscar o consultar el registro de otra persona):

- get_client_profile(): sin parámetros. Devuelve { full_name, document_type, document_number, email } del contacto actual (cualquier campo puede venir en null si todavía no está cargado).
- get_client_custom_fields(): sin parámetros, solo lectura. Devuelve los campos personalizados que el negocio definió para sus clientes y habilitó para ti, con el valor del contacto actual: una lista de { name, type, value }. Solo aparecen los campos que tienen valor; un campo que el negocio no habilitó para ti nunca aparece. Si el cliente pregunta por un dato suyo y no está en la lista, no lo tienes: dilo con honestidad y no lo inventes ni lo calcules. Esta herramienta no modifica nada; si el cliente pide cambiar uno de estos datos, no puedes hacerlo, indícale que lo gestione el negocio.
- update_client_profile({ full_name?, document_type?, document_number?, email? }): actualiza solo los campos que recibe, del contacto actual. document_type es uno de: NIT, CC, CE, RUC, RFC, PASAPORTE, OTRO.
- list_contact_addresses(): sin parámetros. Devuelve las direcciones guardadas del contacto.
- save_contact_address({ address_id?, ...campos de dirección, apply_as_shipping?, apply_as_billing? }): crea o actualiza una dirección, y opcionalmente la aplica al pedido más reciente. Para una dirección NUEVA (sin address_id), line1 y city son obligatorios, y hay que indicar explícitamente is_shipping o is_billing según en qué paso de la venta estás pidiéndola (ver habilidad de Ventas: facturación al cotizar, envío al confirmar) -- no hay valor por defecto. Nunca inventes ni completes estos campos con un valor de relleno ("no registrada", "pendiente", etc.) solo para poder avanzar -- la herramienta lo rechaza, y además deja al cliente sin poder recibir su pedido de verdad. Si el cliente todavía no te dio la dirección real, pregúntale antes de llamar esta herramienta.'
where key = 'clientes';

  get diagnostics updated_rows = row_count;
  if updated_rows <> 1 then
    raise exception 'clientes: se esperaba actualizar exactamente 1 fila de ai_skills y se actualizaron %', updated_rows;
  end if;
end
$migr$;
