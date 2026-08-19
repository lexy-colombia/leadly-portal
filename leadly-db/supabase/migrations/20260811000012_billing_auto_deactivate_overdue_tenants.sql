-- Closes the gap the user flagged: tenant access (tenants.status) was only
-- ever changed by a human clicking Activar/Desactivar -- completely
-- disconnected from whether the tenant actually owes money. Mirrors lexy's
-- deactivate_companies_with_overdue_invoices (hourly cron, companies.is_active
-- flips to false once an invoice has been unpaid for a couple of days) so
-- that access is a direct, automatic consequence of unpaid invoices, not a
-- separately-managed "subscription state". Reactivating stays manual (the
-- superadmin confirms the payment and flips it back), same as lexy -- there's
-- no auto-reactivation trigger there either.
create or replace function public.mark_overdue_invoices() returns void
language sql
security definer
set search_path = public
as $$
  update public.payment_invoices
  set status = 'OVERDUE'
  where status = 'PENDING'
  and due_date is not null
  and due_date < current_date
  and deleted_at is null;
$$;

-- 3-day grace period past due_date before access is cut -- due_date on the
-- initial/renewal invoice is already several days out from issue, so this is
-- on top of that, not instead of it.
create or replace function public.deactivate_tenants_with_overdue_invoices() returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.mark_overdue_invoices();

  update public.tenants t
  set status = 'inactive'
  where t.status = 'active'
  and exists (
    select 1 from public.payment_invoices pi
    where pi.payer_tenant_id = t.id
    and pi.status in ('PENDING', 'OVERDUE')
    and pi.deleted_at is null
    and pi.due_date is not null
    and pi.due_date < current_date - interval '3 days'
  );
end;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deactivate_tenants_with_overdue_invoices') THEN
    PERFORM cron.schedule(
      'deactivate_tenants_with_overdue_invoices',
      '0 * * * *',
      'SELECT public.deactivate_tenants_with_overdue_invoices()'
    );
  END IF;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
