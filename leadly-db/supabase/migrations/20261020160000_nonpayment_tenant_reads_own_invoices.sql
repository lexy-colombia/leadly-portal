-- ST3 (D7): muro de pago. Un tenant bloqueado POR MORA (status 'inactive' y suspension_reason
-- 'nonpayment') puede LEER sus propios comprobantes, sus items y sus intentos de pago para poder
-- pagarlos. Hoy no puede: payment_invoices_select usa auth_active_tenant_id(), que es NULL si el
-- tenant no esta 'active'.
--
-- Alcance MINIMO y ADITIVO:
--  * No se modifica ninguna policy existente (un tenant activo ve exactamente lo mismo que antes).
--  * Solo SELECT, solo estas 3 tablas. Ninguna escritura. Ninguna otra tabla (el tenant bloqueado
--    sigue sin leer clientes, ventas, etc.).
--  * Un bloqueo MANUAL (suspension_reason null) no abre nada: el helper devuelve NULL.
--  * `payer_tenant_id = NULL` nunca es verdadero, asi que cualquiera que no este en mora
--    (anon, superadmin sin tenant, tenant activo, bloqueo manual) no gana nada con estas policies.

create or replace function public.auth_nonpayment_tenant_id() returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.tenant_id
  from public.profiles p
  join public.tenants t on t.id = p.tenant_id
  where p.id = auth.uid()
    and t.status = 'inactive'
    and t.suspension_reason = 'nonpayment';
$$;

revoke all on function public.auth_nonpayment_tenant_id() from public, anon;
grant execute on function public.auth_nonpayment_tenant_id() to authenticated, service_role;

drop policy if exists payment_invoices_select_nonpayment on public.payment_invoices;
create policy payment_invoices_select_nonpayment on public.payment_invoices
  for select to authenticated
  using (payer_tenant_id = (select public.auth_nonpayment_tenant_id()));

drop policy if exists payment_invoice_items_select_nonpayment on public.payment_invoice_items;
create policy payment_invoice_items_select_nonpayment on public.payment_invoice_items
  for select to authenticated
  using (
    exists (
      select 1 from public.payment_invoices i
      where i.id = payment_invoice_items.invoice_id
        and i.payer_tenant_id = (select public.auth_nonpayment_tenant_id())
    )
  );

drop policy if exists payment_attempts_select_nonpayment on public.payment_attempts;
create policy payment_attempts_select_nonpayment on public.payment_attempts
  for select to authenticated
  using (
    exists (
      select 1 from public.payment_invoices i
      where i.id = payment_attempts.invoice_id
        and i.payer_tenant_id = (select public.auth_nonpayment_tenant_id())
    )
  );
