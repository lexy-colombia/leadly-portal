-- Bloqueo por mora que funcione + reactivacion automatica al pagar (D4, D5, D6).
-- Plan: progress/feature_billing_prepaid.md.
--
-- D5 (el bug): tenants_prevent_self_service_escalation (20260816030001) lanza
-- excepcion si cambia tenants.status y is_superadmin() es false. is_superadmin()
-- lee profiles por auth.uid(), que es NULL dentro de pg_cron (el job corre como
-- postgres), asi que el UPDATE de deactivate_tenants_with_overdue_invoices() habria
-- fallado ENTERO (incluido mark_overdue_invoices, misma transaccion) cada hora en
-- cuanto un tenant cumpliera la condicion. No se vio porque ninguno la cumplio.
-- Arreglo: el guard deja pasar el contexto de sistema --auth.role() es NULL en
-- pg_cron/SQL directo y 'service_role' en Edge Functions de confianza-- y sigue
-- bloqueando a 'anon' y 'authenticated' (salvo superadmin).
-- Ademas el guard protege las dos columnas nuevas (suspension_reason,
-- suspended_at): sin eso un tenant_admin (policy tenants_self_update) bloqueado a
-- mano podria escribirse suspension_reason='nonpayment' y dejar que el cron lo
-- reactive solo, saltandose el bloqueo manual del superadmin.
--
-- D4: tenants.suspension_reason ('nonpayment' | NULL) y suspended_at. NULL = bloqueo
-- manual (jamas se reactiva solo). Un trigger BEFORE UPDATE OF status limpia ambos al
-- pasar a 'active' (cubre la reactivacion manual del backoffice sin tocar frontend).
-- CHECK: solo un tenant 'inactive' puede tener motivo.
--
-- D6: deactivate_tenants_with_overdue_invoices() (cron horario) marca vencidas,
-- bloquea con motivo a los tenants activos con comprobante PENDING/OVERDUE vencido
-- hace mas de 3 dias (condicion vigente) y REACTIVA a los bloqueados por mora que ya
-- no tengan ninguno. Un trigger AFTER UPDATE OF status en payment_invoices intenta la
-- misma reactivacion al pasar a PAID; si falla, WARNING y NO se revierte el pago (el
-- cron horario lo cubre).
--
-- Comportamiento a conocer (H4 del review): reactivar A MANO a un tenant que todavia tiene un
-- comprobante vencido hace mas de 3 dias NO lo libera: el cron horario lo vuelve a bloquear en
-- la hora siguiente, con un suspended_at nuevo y sin aviso. Es consecuencia de la regla de mora,
-- no un bug. Para liberarlo de verdad hay que registrar el pago, mover el due_date o anular el
-- comprobante. La UI (ST2/ST3) debe decirlo.
--
-- Privilegios: las funciones nuevas quedan solo para service_role/owner, como
-- 20261013140000 (nada para anon/authenticated).
-- Idempotente (if not exists / create or replace / drop trigger if exists).

-- ---------------------------------------------------------------- D4
alter table public.tenants
  add column if not exists suspension_reason text,
  add column if not exists suspended_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_suspension_reason_check'
                 and conrelid = 'public.tenants'::regclass) then
    alter table public.tenants
      add constraint tenants_suspension_reason_check
      check (suspension_reason is null or suspension_reason in ('nonpayment'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tenants_suspension_requires_inactive_check'
                 and conrelid = 'public.tenants'::regclass) then
    alter table public.tenants
      add constraint tenants_suspension_requires_inactive_check
      check (suspension_reason is null or status = 'inactive');
  end if;
end
$$;

create or replace function public.tenants_clear_suspension_on_activate() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.suspension_reason := null;
  new.suspended_at := null;
  return new;
end;
$$;

drop trigger if exists tenants_clear_suspension_on_activate on public.tenants;
create trigger tenants_clear_suspension_on_activate
  before update of status on public.tenants
  for each row
  when (new.status = 'active' and old.status is distinct from 'active')
  execute function public.tenants_clear_suspension_on_activate();

-- ---------------------------------------------------------------- D5
create or replace function public.prevent_tenant_self_service_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Superadmin, o contexto de sistema (pg_cron / SQL directo: auth.role() NULL;
  -- Edge Functions de confianza: 'service_role'). Solo 'anon' y 'authenticated'
  -- pasan por la validacion.
  if public.is_superadmin() or coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    return new;
  end if;

  if new.status is distinct from old.status
    or new.id is distinct from old.id
    or new.created_at is distinct from old.created_at
    or new.suspension_reason is distinct from old.suspension_reason
    or new.suspended_at is distinct from old.suspended_at
  then
    raise exception 'Not authorized to change status/id/created_at on this tenant';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------- D6
-- Predicado unico de "este tenant debe estar bloqueado por mora".
create or replace function public.tenant_has_blocking_invoice(p_tenant_id uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.payment_invoices pi
    where pi.payer_tenant_id = p_tenant_id
    and pi.status in ('PENDING', 'OVERDUE')
    and pi.deleted_at is null
    and pi.due_date is not null
    and pi.due_date < current_date - interval '3 days'
  );
$$;

create or replace function public.reactivate_tenant_if_paid(p_tenant_id uuid) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  update public.tenants t
  set status = 'active'
  where t.id = p_tenant_id
  and t.status = 'inactive'
  and t.suspension_reason = 'nonpayment'
  and not public.tenant_has_blocking_invoice(t.id);
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

create or replace function public.deactivate_tenants_with_overdue_invoices() returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.mark_overdue_invoices();

  -- Bloquear (motivo: mora). Gracia de 3 dias vencido el comprobante.
  update public.tenants t
  set status = 'inactive',
      suspension_reason = 'nonpayment',
      suspended_at = now()
  where t.status = 'active'
  and public.tenant_has_blocking_invoice(t.id);

  -- Reactivar SOLO los bloqueados por mora que ya no deben nada vencido. Un
  -- bloqueo manual (suspension_reason NULL) nunca se toca.
  update public.tenants t
  set status = 'active'
  where t.status = 'inactive'
  and t.suspension_reason = 'nonpayment'
  and not public.tenant_has_blocking_invoice(t.id);
end;
$$;

create or replace function public.payment_invoices_reactivate_tenant_on_paid() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'PAID' and old.status is distinct from 'PAID' and new.payer_tenant_id is not null then
    begin
      perform public.reactivate_tenant_if_paid(new.payer_tenant_id);
    exception when others then
      -- Nunca revertir el pago por un fallo de la reactivacion: el cron horario
      -- (deactivate_tenants_with_overdue_invoices) la reintenta.
      raise warning 'payment_invoices_reactivate_tenant_on_paid: no se pudo reactivar al tenant % (el cron lo reintenta): %', new.payer_tenant_id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists payment_invoices_reactivate_tenant on public.payment_invoices;
create trigger payment_invoices_reactivate_tenant
  after update of status on public.payment_invoices
  for each row execute function public.payment_invoices_reactivate_tenant_on_paid();

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.tenant_has_blocking_invoice(uuid)',
    'public.reactivate_tenant_if_paid(uuid)',
    'public.payment_invoices_reactivate_tenant_on_paid()',
    'public.deactivate_tenants_with_overdue_invoices()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', v_sig);
    execute format('grant execute on function %s to service_role', v_sig);
  end loop;
end
$$;
