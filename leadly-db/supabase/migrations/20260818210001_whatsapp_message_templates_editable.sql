-- Dos fixes reales encontrados al probar Fase 1 con una plantilla rechazada
-- de verdad (ver CLAUDE.md, "iniciar conversaciones"):
--
-- 1) Una plantilla RECHAZADA por Meta no tenía forma de editarse y volver a
-- mandarse a revisión -- solo se podía eliminar (soft-delete local) y crear
-- una con nombre distinto. Meta sí soporta editar el contenido de una
-- plantilla existente vía POST /{template_id} (vuelve a PENDING), así que
-- el Edge Function whatsapp-manage-templates gana una acción "edit" que usa
-- ese endpoint en vez de crear un objeto nuevo en el WABA.
--
-- 2) unique(tenant_id, name, language) no filtraba deleted_at is null -- una
-- plantilla eliminada (soft-delete) seguía bloqueando el nombre para
-- siempre, así que ni "eliminar y crear una nueva con el mismo nombre" era
-- una alternativa real al punto 1. Se reemplaza por un índice único parcial.

alter table public.whatsapp_message_templates drop constraint whatsapp_message_templates_tenant_id_name_language_key;

create unique index whatsapp_message_templates_tenant_name_language_active_idx
  on public.whatsapp_message_templates(tenant_id, name, language)
  where deleted_at is null;
