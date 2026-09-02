-- Fase 3 de "oportunidades/tareas/citas transversal" (pedido explícito del
-- usuario, 2026-09-02): las citas ya recuerdan solas por WhatsApp
-- (send-appointment-reminders), pero una tarea vencida nunca le avisaba a
-- nadie -- un agente solo se enteraba si entraba a mirar Calendario/
-- Dashboard por su cuenta. Mismo mecanismo que las citas (pedido explícito
-- del usuario), pero apuntado distinto: una cita le recuerda al CONTACTO su
-- propia cita; una tarea es interna, así que le avisa al AGENTE asignado a
-- su propio teléfono (profiles.phone, el mismo que edita en "Mi cuenta") vía
-- la línea de WhatsApp del tenant -- no hay ningún otro canal de
-- notificación interna hoy (sin email transaccional propio en el proyecto).
--
-- reminder_sent_at (mismo campo que appointments) evita reenviar la misma
-- tarea en cada tick del cron -- se envía UNA vez, apenas se detecta
-- vencida (a diferencia de las citas, que avisan ~1h ANTES porque tienen una
-- hora de encuentro real; una tarea no tiene "hora del evento", solo un
-- deadline, así que "avisame que ya se venció" es la señal que importa acá).
alter table public.tasks add column reminder_sent_at timestamptz;

-- Reusa el mismo secreto de Vault que ya usan send-appointment-reminders y
-- run-campaigns (internal_secrets.key = 'cron_reminder_secret' / Deno env
-- CRON_REMINDER_SECRET) -- no hace falta generar uno nuevo, ningún cron
-- propio de Leadly necesita un secreto distinto de los otros.
create or replace function public.trigger_task_reminders()
returns void
language plpgsql
security definer
set search_path = public, vault, net
as $$
declare
  v_secret_id uuid;
  v_key text;
begin
  select secret_id into v_secret_id from public.internal_secrets where key = 'cron_reminder_secret';
  if v_secret_id is null then
    return;
  end if;

  select decrypted_secret into v_key from vault.decrypted_secrets where id = v_secret_id;
  if v_key is null then
    return;
  end if;

  perform net.http_post(
    url := 'https://kkdtrkfcnyvuefazndnj.supabase.co/functions/v1/send-task-reminders',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

revoke execute on function public.trigger_task_reminders() from public, anon, authenticated;

-- Cada 15 min -- una tarea no necesita la precisión de 5 min que sí importa
-- para una cita con hora fija de encuentro.
select cron.schedule('send-task-reminders', '*/15 * * * *', $$select public.trigger_task_reminders();$$);
