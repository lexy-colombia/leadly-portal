-- Trazabilidad de los avisos de lead nuevo (Edge Function notify-sales-lead).
-- Estos objetos ya existen en producción pero se crearon sin archivo de
-- migración. Esta migración los deja en el repo; es un NO-OP sobre la base
-- viva (todo idempotente) y los crea en una base nueva.
alter table public.opportunities add column if not exists lead_alert_sent_at timestamptz;
comment on column public.opportunities.lead_alert_sent_at is
  'Cuándo se avisó por WhatsApp de esta oportunidad al equipo comercial. Null = todavía no. Un solo aviso por oportunidad, nunca repetido.';

alter table public.tenants add column if not exists sales_notification_phone text;
comment on column public.tenants.sales_notification_phone is
  'WhatsApp (formato internacional sin +) al que se avisa cuando la IA registra un interesado nuevo. Null = sin aviso. Ver la Edge Function notify-sales-lead.';

create index if not exists opportunities_pending_lead_alert_idx
  on public.opportunities using btree (created_at)
  where (lead_alert_sent_at is null and deleted_at is null);

create or replace function public.trigger_sales_lead_alerts()
returns void
language plpgsql
security definer
set search_path = public
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
    url := 'https://kkdtrkfcnyvuefazndnj.supabase.co/functions/v1/notify-sales-lead',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
end;
$$;

select cron.schedule('send-sales-lead-alerts', '*/5 * * * *', $$select public.trigger_sales_lead_alerts();$$)
where not exists (select 1 from cron.job where jobname = 'send-sales-lead-alerts');
