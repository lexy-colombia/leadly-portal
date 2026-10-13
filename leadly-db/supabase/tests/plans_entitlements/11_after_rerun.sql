set client_min_messages = notice;
do $$
declare v_diff int;
begin
  select count(*) into v_diff from (
    (select * from t.snap_final except select tenant_id, module_key, source from public.tenant_enabled_modules)
    union all
    (select tenant_id, module_key, source from public.tenant_enabled_modules except select * from t.snap_final)) d;
  perform t.chk('8.1 re-ejecutar la migracion 2 veces no cambia tenant_enabled_modules', v_diff = 0, 'diferencias=' || v_diff);
  select count(*) into v_diff from (
    (select * from t.snap_billed except select id, setup_fee_billed_at from public.billing_subscriptions)
    union all
    (select id, setup_fee_billed_at from public.billing_subscriptions except select * from t.snap_billed)) d;
  perform t.chk('8.2 re-ejecutar NO marca como facturadas suscripciones pendientes (backfill de una sola vez)', v_diff = 0, 'diferencias=' || v_diff);
  perform t.chk('8.3 la custom sin precio (LN) conserva setup_fee_billed_at NULL',
    (select setup_fee_billed_at is null from public.billing_subscriptions where tenant_id = (select id from public.tenants where name = 'LN')));
  select count(*) into v_diff from (
    (select * from t.snap_inv except select id, amount_cents, status from public.payment_invoices)
    union all
    (select id, amount_cents, status from public.payment_invoices except select * from t.snap_inv)) d;
  perform t.chk('8.4 re-ejecutar no altera facturas', v_diff = 0, 'diferencias=' || v_diff);
  perform t.chk('8.5 una sola definicion de cada trigger de sync (sin duplicados)',
    (select count(*) from pg_trigger where tgname like 'billing\_%\_sync\_%' and not tgisinternal) = 9
    and (select count(*) from pg_trigger where tgrelid = 'public.billing_subscriptions'::regclass and tgname like 'billing\_subscriptions\_sync%') = 2,
    (select count(*) from pg_trigger where tgname like 'billing\_%\_sync\_%')::text);
end $$;
