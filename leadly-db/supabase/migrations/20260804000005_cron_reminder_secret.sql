-- Switches the cron -> send-appointment-reminders auth from
-- SUPABASE_SERVICE_ROLE_KEY to a dedicated CRON_REMINDER_SECRET: the
-- platform can silently change the format of the injected service role key
-- (legacy JWT vs the newer sb_secret_... form), which breaks a copy stored
-- ahead of time in Vault for a cron job (discovered live this session --
-- whatsapp-webhook/whatsapp-ai-respond stayed fine because both sides read
-- their own current env var at call time, but this cron path pre-stores the
-- value). A secret Leadly's own code exclusively sets and reads has no such
-- rotation risk.
create or replace function public.trigger_appointment_reminders()
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
    url := 'https://kkdtrkfcnyvuefazndnj.supabase.co/functions/v1/send-appointment-reminders',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

delete from public.internal_secrets where key = 'service_role_key';
