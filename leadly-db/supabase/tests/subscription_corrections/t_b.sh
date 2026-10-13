# Migracion B (fechas de Moyano) y flujo completo A -> 170000 -> 180000 -> B.
MND="select md5(coalesce(string_agg(x,'|' order by x),'')) from (
  select (to_jsonb(s) - 'created_at' - 'updated_at' - 'current_period_start' - 'current_period_end' - 'setup_fee_billed_at')::text x from public.billing_subscriptions s where s.id='$MSUB'
  union all select (to_jsonb(i) - 'created_at' - 'updated_at' - 'due_date' - 'invoice_number')::text from public.payment_invoices i where i.payer_tenant_id='$M'
  union all select it::text from public.payment_invoice_items it join public.payment_invoices i on i.id=it.invoice_id where i.payer_tenant_id='$M'
  union all select (to_jsonb(a) - 'created_at')::text from public.payment_attempts a join public.payment_invoices i on i.id=a.invoice_id where i.payer_tenant_id='$M'
  union all select sm::text from public.billing_subscription_modules sm where sm.subscription_id='$MSUB'
  union all select m::text from public.tenant_enabled_modules m where m.tenant_id='$M') z"
apply_chain() { # A, 170000, 180000 (B lo aplica quien llama)
  build_base
  for f in "$MIG_A" "$MIG_170" "$MIG_180"; do $P -f "$f" >/dev/null 2>&1 || fail_setup "cadena: $f"; done
}
MINV="(select id from public.payment_invoices where payer_tenant_id='$M')"

echo "== B: flujo real A -> 170000 -> 180000 -> B"
build_base
fp bf0
MND0=$($P -c "$MND")
for f in "$MIG_A" "$MIG_170" "$MIG_180"; do
  OUTC=$($P -f "$f" 2>&1); RCC=$?
  chk "C0 $(basename "$f") corre sin error" "$(b2s $([ $RCC -eq 0 ] && echo true || echo false))"
done
fp bf1
OUTB1=$($P -f "$MIG_B" 2>&1); RCB1=$?
echo "$OUTB1" | sed -E 's/^psql:[^ ]+ //' | grep -E 'NOTICE|ERROR' || true
fp bf2
MND2=$($P -c "$MND")
OUTB2=$($P -f "$MIG_B" 2>&1); RCB2=$?
echo "$OUTB2" | sed -E 's/^psql:[^ ]+ //' | grep -E 'NOTICE|ERROR' || true
fp bf3
chk "B0 la migracion B corre sin error (rc=0)" "$(b2s $([ "$RCB1" -eq 0 ] && echo true || echo false))"
chk "B1 Barriles: UNA suscripcion enterprise ACTIVE, base 14000000, implementacion 0" \
  "(select count(*)=1 and bool_and(p.key='enterprise' and s.status='ACTIVE' and s.custom_base_amount_cents=14000000 and s.setup_fee_override_cents=0) from public.billing_subscriptions s join public.billing_plans p on p.id=s.plan_id where s.tenant_id='$B')"
chk "B2 Barriles: 2 facturas, PAID due 2026-10-10 y PENDING due 2026-11-10, ambas 14000000, sin implementacion" \
  "(select count(*)=2 and count(*) filter (where status='PAID' and due_date='2026-10-10' and amount_cents=14000000)=1 and count(*) filter (where status='PENDING' and due_date='2026-11-10' and amount_cents=14000000)=1 from public.payment_invoices where payer_tenant_id='$B') and (select count(*)=0 from public.payment_invoice_items it join public.payment_invoices i on i.id=it.invoice_id where i.payer_tenant_id='$B' and it.description like 'Implementaci%')"
chk "B3 Moyano: periodo [2026-10-05, 2026-11-05] 00:00 Bogota, created_at y setup_fee_billed_at 2026-10-05, ACTIVE" \
  "(select current_period_start='2026-10-05 00:00:00-05' and current_period_end='2026-11-05 00:00:00-05' and created_at='2026-10-05 00:00:00-05' and setup_fee_billed_at='2026-10-05 00:00:00-05' and status='ACTIVE' from public.billing_subscriptions where id='$MSUB')"
chk "B4 Moyano: factura PAID 40000000, due 2026-11-05, created_at 2026-10-05, numero INV-20261005-00a5f0, unica" \
  "(select count(*)=1 and bool_and(status='PAID' and amount_cents=40000000 and due_date='2026-11-05' and created_at='2026-10-05 00:00:00-05' and invoice_number='INV-20261005-00a5f0') from public.payment_invoices where payer_tenant_id='$M')"
chk "B5 Moyano: intento manual APPROVED 40000000 con created_at 2026-10-05; 15 modulos intactos" \
  "(select count(*)=1 and bool_and(provider_key='manual' and status='APPROVED' and amount_cents=40000000 and created_at='2026-10-05 00:00:00-05') from public.payment_attempts where invoice_id=$MINV) and (select count(*)=15 from public.billing_subscription_modules where subscription_id='$MSUB')"
chk "B6 B solo cambio fechas: Moyano sin fechas identico antes/despues de B (huella md5)" "$(b2s $([ "$MND0" = "$MND2" ] && echo true || echo false))"
chk "B7 tenants, planes, modulos de plan y tenant_enabled_modules ajenos a Barriles intactos tras toda la cadena (huellas md5)" \
  "$(fpv bf0 tenants h)=$(fpv bf3 tenants h) and $(fpv bf0 plans h)=$(fpv bf3 plans h) and $(fpv bf0 plan_modules h)=$(fpv bf3 plan_modules h) and $(fpv bf0 other_tem h)=$(fpv bf3 other_tem h) and $(fpv bf0 other_subs h)=$(fpv bf3 other_subs h) and $(fpv bf0 other_inv h)=$(fpv bf3 other_inv h)"
chk "B8 B no toca a nadie mas: nada ajeno a Moyano cambia entre 180000 y B (huellas md5)" \
  "$(fpv bf1 tenants h)=$(fpv bf2 tenants h) and $(fpv bf1 tem h)=$(fpv bf2 tem h) and $(fpv bf1 other_subs h)=$(fpv bf2 other_subs h) and $(fpv bf1 other_inv h)=$(fpv bf2 other_inv h) and $(fpv bf1 sub_modules_not_b h)=$(fpv bf2 sub_modules_not_b h)"
chk "B9 2a corrida de B: rc=0, avisa ya aplicada, Moyano identico (huella md5)" \
  "$(b2s $([ "$RCB2" -eq 0 ] && echo true || echo false)) and $(b2s $(echo "$OUTB2" | grep -q 'ya aplicada' && echo true || echo false)) and $(fpv bf2 m_state h)=$(fpv bf3 m_state h)"

echo "== B: crons con reloj falso (estado final de la cadena)"
patch_clock
setclock '2026-10-13 12:00:00-05'; crons
chk "K1 hoy 2026-10-13: nadie desactivado, periodos y facturas sin cambios" \
  "(select count(*)=0 from public.tenants where id in ('$B','$M') and status<>'active') and (select current_period_end='2026-11-05 00:00:00-05' from public.billing_subscriptions where id='$MSUB') and (select count(*)=1 from public.payment_invoices where payer_tenant_id='$M') and (select count(*)=2 from public.payment_invoices where payer_tenant_id='$B')"
setclock '2026-11-02 07:00:00-05'; crons
chk "K2 2026-11-02 07:00: Moyano avanza a [11-05, 12-05] y genera UNA factura due 2026-12-05 PENDING por 20000000 (sin implementacion)" \
  "(select current_period_start='2026-11-05 00:00:00-05' and current_period_end='2026-12-05 00:00:00-05' from public.billing_subscriptions where id='$MSUB') and (select count(*)=1 and bool_and(status='PENDING' and amount_cents=20000000) from public.payment_invoices where payer_tenant_id='$M' and due_date='2026-12-05') and (select count(*)=0 from public.payment_invoice_items it join public.payment_invoices i on i.id=it.invoice_id where i.payer_tenant_id='$M' and i.due_date='2026-12-05' and it.description like 'Implementaci%')"
crons
chk "K3 2a corrida del cron el mismo dia: sin duplicados (2 facturas de Moyano)" \
  "(select count(*)=2 from public.payment_invoices where payer_tenant_id='$M') and (select current_period_end='2026-12-05 00:00:00-05' from public.billing_subscriptions where id='$MSUB')"
chk "K4 2026-11-02: nadie desactivado" "(select count(*)=0 from public.tenants where id in ('$B','$M') and status<>'active')"
setclock '2026-11-07 07:00:00-05'; crons
chk "K5 2026-11-07 07:00: Barriles avanza a [11-10, 12-10] y genera factura due 2026-12-10 por 14000000; sigue activo" \
  "(select current_period_end='2026-12-10 00:00:00-05' from public.billing_subscriptions where tenant_id='$B') and (select count(*)=1 from public.payment_invoices where payer_tenant_id='$B' and due_date='2026-12-10' and amount_cents=14000000) and (select status='active' from public.tenants where id='$B')"
setclock '2026-11-12 12:00:00-05'; crons
chk "K6 2026-11-12 (2 dias tras el vencimiento 11-10 sin pagar): Barriles sigue activo" "(select status='active' from public.tenants where id='$B')"
setclock '2026-12-07 12:00:00-05'; crons
chk "K7 2026-12-07 (2 dias tras el vencimiento 12-05 de Moyano sin pagar): Moyano sigue activo" "(select status='active' from public.tenants where id='$M')"
setclock '2026-12-09 12:00:00-05'; crons
chk "K8 control: pasados 3 dias del vencimiento sin pagar el cron SI desactiva (la prueba no es vacua)" "(select status='inactive' from public.tenants where id='$M')"

echo "== B: negativos (cada guarda aborta sin escribir)"
SNAP="select md5(coalesce(string_agg(x,'|' order by x),'')) from (select s::text x from public.billing_subscriptions s union all select i::text from public.payment_invoices i union all select a::text from public.payment_attempts a union all select it::text from public.payment_invoice_items it) z"
neg_b() { # $1 nombre, $2 SQL de preparacion
  echo "-- negativo: $1"
  build_base
  $P -c "$2" >/dev/null || fail_setup "prep $1"
  local before after out rc
  before=$($P -c "$SNAP")
  out=$($P -f "$MIG_B" 2>&1); rc=$?
  echo "$out" | sed -E 's/^psql:[^ ]+ //' | grep -m1 -E 'ERROR' || true
  after=$($P -c "$SNAP")
  chk "$1: aborta (exit != 0)" "$(b2s $([ $rc -ne 0 ] && echo true || echo false))"
  chk "$1: mensaje de la guarda" "$(b2s $(echo "$out" | grep -q 'correct_moyano_subscription_dates' && echo true || echo false))"
  chk "$1: no escribio nada (huella md5)" "$(b2s $([ "$before" = "$after" ] && echo true || echo false))"
}
neg_b "NB1 monto de la factura distinto" "update public.payment_invoices set amount_cents=39000000 where payer_tenant_id='$M'"
neg_b "NB2 mas de una factura" "insert into public.payment_invoices(payer_tenant_id, subscription_id, provider_key, amount_cents, status) values ('$M','$MSUB','manual',100,'PENDING')"
neg_b "NB3 periodo distinto del esperado" "update public.billing_subscriptions set current_period_end='2026-12-20 00:00:00-05' where id='$MSUB'"
neg_b "NB4 la factura no esta PAID" "update public.payment_invoices set status='PENDING' where payer_tenant_id='$M'"
neg_b "NB5 suscripcion de otro tenant" "update public.billing_subscriptions set tenant_id='$B' where id='$MSUB'"
neg_b "NB6 mas de un intento de pago" "insert into public.payment_attempts(invoice_id, provider_key, status, amount_cents, currency) select id,'manual','APPROVED',100,'COP' from public.payment_invoices where payer_tenant_id='$M'"
neg_b "NB7 suscripcion inexistente" "delete from public.payment_invoices where payer_tenant_id='$M'; delete from public.billing_subscriptions where id='$MSUB'"

echo "== B: aplicar B sin A ni 170000 (solo toca a Moyano)"
build_base
fp bo0
$P -f "$MIG_B" >/dev/null 2>&1; RCO=$?
fp bo1
chk "O1 B sola corre sin error y corrige a Moyano" \
  "$(b2s $([ $RCO -eq 0 ] && echo true || echo false)) and (select current_period_end='2026-11-05 00:00:00-05' from public.billing_subscriptions where id='$MSUB')"
chk "O2 B sola no cambia nada mas: Barriles conserva su Business y su factura; tenants, tem, planes, ajenos (huellas md5)" \
  "(select count(*)=1 and bool_and(status='PENDING_PAYMENT') from public.billing_subscriptions where tenant_id='$B') and (select count(*)=1 and bool_and(amount_cents=49000000) from public.payment_invoices where payer_tenant_id='$B') and $(fpv bo0 tenants h)=$(fpv bo1 tenants h) and $(fpv bo0 tem h)=$(fpv bo1 tem h) and $(fpv bo0 plans h)=$(fpv bo1 plans h) and $(fpv bo0 other_subs h)=$(fpv bo1 other_subs h) and $(fpv bo0 other_inv h)=$(fpv bo1 other_inv h)"

echo "== B: mutaciones"
if [ -z "${NO_MUT:-}" ]; then
  mutB() { # $1 nombre, $2 expresion perl, $3 puerto
    perl -0pe "$2" "$MIGS/20261013190000_correct_moyano_subscription_dates.sql" > "$WORK/mutB.sql"
    if cmp -s "$WORK/mutB.sql" "$MIGS/20261013190000_correct_moyano_subscription_dates.sql"; then
      chk "$1: la mutacion se aplico" false; return
    fi
    NO_MUT=1 MIG_B_OVERRIDE="$WORK/mutB.sql" PGPORT_TEST=$3 "$0" > "$WORK/mutB.out" 2>&1; local rc=$?
    echo "   $1 -> exit $rc: $(grep RESUMEN "$WORK/mutB.out")"
    chk "$1: la prueba falla con la migracion mutada (exit 1)" "$(b2s $([ $rc -eq 1 ] && echo true || echo false))"
  }
  mutB "MB1 sin cambiar created_at/due_date de la factura" 's/set due_date = c_due,\s*created_at = c_start,/set/' 54395
  mutB "MB2 periodo sin corregir" 's/current_period_start = c_start,\s*current_period_end = c_end,\s*//' 54396
  mutB "MB3 sin la guarda de monto (previa y posterior)" 's/v_inv\.amount_cents <> 40000000/false/g' 54397
  mutB "MB4 sin cambiar el estado del intento (created_at del intento)" 's/update public\.payment_attempts set created_at = c_start where invoice_id = c_inv;//' 54398
fi
