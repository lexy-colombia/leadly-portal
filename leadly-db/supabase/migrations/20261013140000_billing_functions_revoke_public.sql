-- Endurecimiento: revocar EXECUTE a PUBLIC en tres funciones de facturacion
-- SECURITY DEFINER sin argumentos.
--
-- QUE: process_recurring_billing_invoices(), deactivate_tenants_with_overdue_invoices()
-- y mark_overdue_invoices() quedan ejecutables solo por service_role y por su
-- dueno (postgres). Se revoca de PUBLIC, anon y authenticated.
--
-- POR QUE (la trampa de PUBLIC): Postgres concede EXECUTE a PUBLIC por defecto
-- al crear una funcion. La migracion 20260807173703_payment_function_privilege_hardening.sql
-- hizo `revoke execute ... from anon, authenticated`, pero anon y authenticated
-- siguen heredando el permiso de PUBLIC, asi que el revoke no tuvo efecto. En
-- produccion, cualquiera con la anon key publica podia llamarlas por
-- /rest/v1/rpc y avanzar periodos / crear facturas de suscripcion, desactivar
-- comercios con facturas vencidas o marcar facturas OVERDUE.
--
-- NO cambia el comportamiento de los crons: los jobs de pg_cron
-- 'process_recurring_billing_invoices' y 'deactivate_tenants_with_overdue_invoices'
-- corren como el dueno (postgres), que conserva acceso; y
-- deactivate_tenants_with_overdue_invoices() llama a mark_overdue_invoices()
-- dentro de una funcion SECURITY DEFINER (corre como el dueno). Nadie las llama
-- como RPC desde leadly-app ni desde las Edge Functions.
--
-- Idempotente: revoke/grant repetidos son no-ops.
--
-- REVERTIR (no recomendado, reabre el hueco):
--   grant execute on function public.process_recurring_billing_invoices() to public;
--   grant execute on function public.deactivate_tenants_with_overdue_invoices() to public;
--   grant execute on function public.mark_overdue_invoices() to public;

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.process_recurring_billing_invoices()',
    'public.deactivate_tenants_with_overdue_invoices()',
    'public.mark_overdue_invoices()'
  ] loop
    if to_regprocedure(v_sig) is null then
      raise notice 'billing_functions_revoke_public: % no existe, se omite', v_sig;
    else
      execute format('revoke execute on function %s from public, anon, authenticated', v_sig);
      execute format('grant execute on function %s to service_role', v_sig);
    end if;
  end loop;
end
$$;
