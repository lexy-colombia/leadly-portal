-- Dispara run-campaigns cada minuto -- mismo patrón exacto que
-- trigger_appointment_reminders (20260804000004/20260804000005): reusa el
-- mismo secreto ya guardado en Vault (internal_secrets.key =
-- 'cron_reminder_secret' / Deno env CRON_REMINDER_SECRET), no hace falta
-- generar uno nuevo -- ambos cron jobs solo necesitan probar "esta llamada
-- vino del cron propio de Leadly", no hay nada específico de citas en ese
-- secreto. pg_cron/pg_net ya están habilitados desde esa misma migración.

create or replace function public.trigger_run_campaigns()
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
    url := 'https://kkdtrkfcnyvuefazndnj.supabase.co/functions/v1/run-campaigns',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

revoke execute on function public.trigger_run_campaigns() from public, anon, authenticated;

select cron.schedule('run-campaigns', '* * * * *', $$select public.trigger_run_campaigns();$$);
