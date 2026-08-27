-- Encontrado en vivo el 2026-08-24: Meta reentrega un webhook si no recibe
-- un 200 rápido y limpio -- el mismo wamid llegó hasta 6 veces en una
-- misma conversación de prueba, cada uno disparando su propia llamada a
-- whatsapp-ai-respond (mensaje duplicado al cliente + gasto de LLM
-- multiplicado). whatsapp-webhook ya deduplica por wamid antes de insertar
-- (ver el fix en el mismo commit), esto es el backstop a nivel de base.
--
-- Backfill primero: hay filas duplicadas reales de hoy que violarían el
-- índice único si se crea directo -- se conserva la más antigua de cada
-- wamid (la primera vez que realmente se procesó) y se borran las demás.
delete from public.whatsapp_messages a
using public.whatsapp_messages b
where a.wamid is not null
  and a.wamid = b.wamid
  and (a.created_at, a.id) > (b.created_at, b.id);

create unique index whatsapp_messages_wamid_idx
  on public.whatsapp_messages(wamid)
  where wamid is not null;
