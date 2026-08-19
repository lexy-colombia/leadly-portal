-- last_message_at (existente) es direction-agnóstica: un agente puede mandar
-- varios mensajes salientes después del último mensaje real del contacto, y
-- seguiría viéndose "reciente" aunque la ventana de 24h de WhatsApp ya haya
-- cerrado. last_inbound_message_at es la señal real para saber si todavía se
-- puede mandar texto libre o si hace falta una plantilla aprobada -- ver
-- CLAUDE.md, Fase 1 de "iniciar conversaciones".

alter table public.whatsapp_conversations add column last_inbound_message_at timestamptz;

create or replace function public.bump_conversation_last_inbound_message_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.direction = 'inbound' then
    update public.whatsapp_conversations
      set last_inbound_message_at = new.created_at
      where id = new.conversation_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.bump_conversation_last_inbound_message_at() from public;

create trigger trg_whatsapp_messages_bump_conversation_inbound
  after insert on public.whatsapp_messages
  for each row execute function public.bump_conversation_last_inbound_message_at();

-- Backfill de una sola vez para las conversaciones que ya existen.
update public.whatsapp_conversations c
  set last_inbound_message_at = (
    select max(m.created_at)
    from public.whatsapp_messages m
    where m.conversation_id = c.id and m.direction = 'inbound'
  );
