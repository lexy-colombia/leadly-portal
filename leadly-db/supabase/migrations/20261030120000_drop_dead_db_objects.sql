-- Limpieza de objetos muertos (Fase D). No toca appointments.reminder_sent_at
-- ni tasks.reminder_sent_at (la segunda la usa send-task-reminders).

do $$
declare
  v_n int;
begin
  -- Guarda 1: ningún cron job puede nombrar la función.
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    execute $q$select count(*) from cron.job where command ilike '%trigger_appointment_reminders%'$q$ into v_n;
    if v_n > 0 then
      raise exception 'Aborta: % cron job(s) usan trigger_appointment_reminders()', v_n;
    end if;
  end if;

  -- Guarda 2: ningún trigger la usa como función de trigger.
  select count(*) into v_n from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where p.proname = 'trigger_appointment_reminders' and not t.tgisinternal;
  if v_n > 0 then raise exception 'Aborta: un trigger usa trigger_appointment_reminders()'; end if;

  -- Guarda 3: ni FKs, ni vistas, ni funciones referencian las tablas de mapeo.
  select count(*) into v_n from pg_constraint c
   where c.contype = 'f' and c.confrelid in (
     select oid from pg_class where relnamespace = 'public'::regnamespace
        and relname in ('_migration_client_map','_migration_product_map'));
  if v_n > 0 then raise exception 'Aborta: % FK(s) referencian las tablas _migration_*', v_n; end if;

  select count(*) into v_n from pg_views
   where schemaname not in ('pg_catalog','information_schema')
     and definition ~ '_migration_(client|product)_map';
  if v_n > 0 then raise exception 'Aborta: % vista(s) referencian las tablas _migration_*', v_n; end if;

  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p')
     and p.prosrc ~ '_migration_(client|product)_map';
  if v_n > 0 then raise exception 'Aborta: % funcion(es) referencian las tablas _migration_*', v_n; end if;
end $$;

drop function if exists public.trigger_appointment_reminders();
drop table if exists public._migration_client_map;
drop table if exists public._migration_product_map;
