-- Automatic WhatsApp reminder for upcoming appointments: every 5 minutes,
-- ping the send-appointment-reminders Edge Function (service_role-only, see
-- that function's own auth check) which scans crm_appointments for anything
-- ~1h out that hasn't been reminded yet and messages the contact directly.
--
-- The service role key itself is never written into a migration file --
-- it's stored write-only in Vault (same pattern as platform_ai_keys /
-- whatsapp_lines tokens) via a one-off SQL insert run outside of version
-- control, and this wrapper function reads it at call time so pg_cron's job
-- definition only ever references a function name, not a secret.
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table public.internal_secrets (
  key text primary key,
  secret_id uuid not null
);

revoke all on public.internal_secrets from anon, authenticated;

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
  select secret_id into v_secret_id from public.internal_secrets where key = 'service_role_key';
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

revoke execute on function public.trigger_appointment_reminders() from public, anon, authenticated;

select cron.schedule('send-appointment-reminders', '*/5 * * * *', $$select public.trigger_appointment_reminders();$$);
