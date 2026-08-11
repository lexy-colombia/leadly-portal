-- Pedido explícito del usuario: hoy "Desconectar línea de WhatsApp"
-- (delete_whatsapp_line, 20260805000003) es en realidad un hard-delete que
-- se niega por completo si la línea ya tiene conversaciones ("no se va a
-- poder eliminar para no perder el historial") -- deja al tenant sin ninguna
-- forma de desconectar una línea real que ya recibió mensajes. La
-- conversación tiene que sobrevivir (nunca se borra), pero la línea sí tiene
-- que poder quedar inutilizable: nuevo status 'disconnected' -- una línea
-- desconectada no es 'active', así que todo lo que ya filtraba por
-- status = 'active' (respuesta de IA en whatsapp-ai-respond/whatsapp-webhook,
-- recordatorios de citas, el selector de "Nueva conversación") la excluye
-- automáticamente sin tocar ese código. El único camino que no filtraba por
-- status en absoluto era whatsapp-send-human (envío manual de un agente) --
-- se le agrega el chequeo explícito en la misma ronda.
alter table public.whatsapp_lines drop constraint whatsapp_lines_status_check;
alter table public.whatsapp_lines add constraint whatsapp_lines_status_check
  check (status in ('pending_verification', 'active', 'suspended', 'disconnected'));

create or replace function public.delete_whatsapp_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_tenant_id uuid;
  v_secret_id uuid;
  v_status text;
begin
  select tenant_id, access_token_secret_id, status into v_tenant_id, v_secret_id, v_status
  from public.whatsapp_lines where id = p_line_id;

  if v_tenant_id is null then
    raise exception 'whatsapp_line % does not exist', p_line_id;
  end if;

  if not (
    public.is_superadmin()
    or (v_tenant_id = public.auth_tenant_id() and public.auth_role() = 'tenant_admin')
  ) then
    raise exception 'Not authorized to delete this WhatsApp line';
  end if;

  -- Ya desconectada -- no hay nada más que hacer (evita que reintentar la
  -- acción sobre una línea ya inutilizable sea un error).
  if v_status = 'disconnected' then
    return;
  end if;

  if exists (select 1 from public.whatsapp_conversations where whatsapp_line_id = p_line_id) then
    -- Tiene historial real: se mantiene la fila y sus conversaciones tal
    -- cual, pero queda 'disconnected' (no 'active') y sin token -- nada
    -- puede volver a enviarse/recibirse por ella. Reconectar exige asignar
    -- un token nuevo (mismo camino que crear una línea), no reactivar esta.
    if v_secret_id is not null then
      delete from vault.secrets where id = v_secret_id;
    end if;
    update public.whatsapp_lines set status = 'disconnected', access_token_secret_id = null where id = p_line_id;
    return;
  end if;

  -- Sin conversaciones: no hay historial que perder, se puede eliminar del todo.
  delete from public.whatsapp_lines where id = p_line_id;

  if v_secret_id is not null then
    delete from vault.secrets where id = v_secret_id;
  end if;
end;
$$;
