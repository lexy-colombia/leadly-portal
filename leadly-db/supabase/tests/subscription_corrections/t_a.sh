# Migracion A: borrar la Business de Barriles. Se hace `source` desde run.sh.
echo "== A: estado produccion + migracion A (1a vez)"
build_base
chk "S0 sembrado: Barriles con 1 Business PENDING_PAYMENT y 1 factura PENDING 49000000 (14000000+35000000, 2 items)" \
  "(select count(*)=1 and bool_and(p.key='business' and s.status='PENDING_PAYMENT') from public.billing_subscriptions s join public.billing_plans p on p.id=s.plan_id where s.tenant_id='$B') and (select count(*)=1 and bool_and(status='PENDING' and amount_cents=49000000 and due_date='2026-11-13' and invoice_number='INV-20261013-dc88ce') from public.payment_invoices where payer_tenant_id='$B') and (select count(*)=2 from public.payment_invoice_items it join public.payment_invoices i on i.id=it.invoice_id where i.payer_tenant_id='$B')"
chk "S1 sembrado: Moyano Enterprise ACTIVE adelantada, 15 modulos, factura PAID 40000000 con 1 intento" \
  "(select status='ACTIVE' and current_period_start='2026-11-13 04:34:08+00' and current_period_end='2026-12-13 04:34:08+00' from public.billing_subscriptions where id='$MSUB') and (select count(*)=15 from public.billing_subscription_modules where subscription_id='$MSUB') and (select count(*)=1 and bool_and(status='PAID' and amount_cents=40000000 and due_date='2026-11-13') from public.payment_invoices where payer_tenant_id='$M') and (select count(*)=1 from public.payment_attempts a join public.payment_invoices i on i.id=a.invoice_id where i.payer_tenant_id='$M')"
fp before
OUT1=$($P -f "$MIG_A" 2>&1); RC1=$?
echo "$OUT1" | sed -E 's/^psql:[^ ]+ //' | grep -E 'NOTICE|ERROR' || true
fp after1
OUT2=$($P -f "$MIG_A" 2>&1); RC2=$?
echo "$OUT2" | sed -E 's/^psql:[^ ]+ //' | grep -E 'NOTICE|ERROR' || true
fp after2
chk "A1 la migracion corre sin error (rc=0)" "$(b2s $([ "$RC1" -eq 0 ] && echo true || echo false))"
chk "A2 Barriles queda sin suscripciones ni facturas" "$(fpv after1 b_subs n)=0 and $(fpv after1 b_inv n)=0"
chk "A3 sin items ni intentos huerfanos (items/attempts sin factura = 0; items de la factura borrada = 0)" \
  "(select count(*)=0 from public.payment_invoice_items it where not exists (select 1 from public.payment_invoices i where i.id=it.invoice_id)) and (select count(*)=0 from public.payment_attempts a where not exists (select 1 from public.payment_invoices i where i.id=a.invoice_id)) and (select count(*)=0 from public.payment_invoices where subscription_id='$BUS' or invoice_number='INV-20261013-dc88ce')"
chk "A4 Moyano (suscripcion, modulos, factura, items, intento) identico (huella md5)" "$(fpv before m_state h)=$(fpv after1 m_state h)"
chk "A5 tenants, planes, modulos de plan, tenant_enabled_modules (incl. Barriles), suscripciones/facturas ajenas intactos (huellas md5)" \
  "$(fpv before tenants h)=$(fpv after1 tenants h) and $(fpv before plans h)=$(fpv after1 plans h) and $(fpv before plan_modules h)=$(fpv after1 plan_modules h) and $(fpv before tem h)=$(fpv after1 tem h) and $(fpv before other_subs h)=$(fpv after1 other_subs h) and $(fpv before other_inv h)=$(fpv after1 other_inv h) and $(fpv before sub_modules_not_b h)=$(fpv after1 sub_modules_not_b h)"
chk "A6 2a corrida: rc=0, avisa que ya no existe y no cambia nada (huellas iguales)" \
  "$(b2s $([ "$RC2" -eq 0 ] && echo true || echo false)) and $(b2s $(echo "$OUT2" | grep -q 'ya no existe' && echo true || echo false)) and $(fpv after1 m_state h)=$(fpv after2 m_state h) and $(fpv after1 tem h)=$(fpv after2 tem h) and $(fpv after1 tenants h)=$(fpv after2 tenants h) and $(fpv after2 b_subs n)=0 and $(fpv after2 b_inv n)=0"

echo "== A: negativos (cada guarda aborta sin escribir)"
neg_a() { # $1 nombre, $2 SQL de preparacion (sobre el estado de produccion)
  echo "-- negativo: $1"
  build_base
  $P -c "$2" >/dev/null || fail_setup "prep $1"
  fp "na_b"; $P -c "delete from r.fp where phase='na_b' and k in ('b_subs','b_inv')" >/dev/null
  local before out rc
  before=$($P -c "select md5(coalesce(string_agg(x,'|' order by x),'')) from (select s::text x from public.billing_subscriptions s union all select i::text from public.payment_invoices i union all select it::text from public.payment_invoice_items it union all select a::text from public.payment_attempts a union all select sm::text from public.billing_subscription_modules sm union all select m::text from public.tenant_enabled_modules m) z")
  out=$($P -f "$MIG_A" 2>&1); rc=$?
  echo "$out" | sed -E 's/^psql:[^ ]+ //' | grep -m1 -E 'ERROR' || true
  local after
  after=$($P -c "select md5(coalesce(string_agg(x,'|' order by x),'')) from (select s::text x from public.billing_subscriptions s union all select i::text from public.payment_invoices i union all select it::text from public.payment_invoice_items it union all select a::text from public.payment_attempts a union all select sm::text from public.billing_subscription_modules sm union all select m::text from public.tenant_enabled_modules m) z")
  chk "$1: aborta (exit != 0)" "$(b2s $([ $rc -ne 0 ] && echo true || echo false))"
  chk "$1: mensaje de la guarda" "$(b2s $(echo "$out" | grep -q 'delete_barriles_business_subscription' && echo true || echo false))"
  chk "$1: no escribio nada (huella md5 de todas las tablas de billing)" "$(b2s $([ "$before" = "$after" ] && echo true || echo false))"
}
neg_a "NA1 factura de la Business ya PAGADA" "update public.payment_invoices set status='PAID' where subscription_id='$BUS'; update public.billing_subscriptions set status='PENDING_PAYMENT' where id='$BUS'"
neg_a "NA2 intento de pago sobre la factura" "insert into public.payment_attempts(invoice_id, provider_key, status, amount_cents, currency) select id,'manual','PENDING',100,'COP' from public.payment_invoices where subscription_id='$BUS'"
neg_a "NA3 suscripcion de otro tenant" "update public.billing_subscriptions set tenant_id='$M' where id='$BUS'"
neg_a "NA4 modulos negociados guardados" "insert into public.billing_subscription_modules(subscription_id, module_key, price_cents) values ('$BUS','pos',0)"
neg_a "NA5 suscripcion ya ACTIVE" "update public.billing_subscriptions set status='ACTIVE' where id='$BUS'"
neg_a "NA6 plan distinto de business" "update public.billing_subscriptions set plan_id=(select id from public.billing_plans where key='starter') where id='$BUS'"
neg_a "NA7 factura OVERDUE" "update public.payment_invoices set status='OVERDUE' where subscription_id='$BUS'"
neg_a "NA8 Barriles con una factura ajena a la suscripcion" "insert into public.payment_invoices(payer_tenant_id, provider_key, amount_cents, status) values ('$B','manual',100,'PENDING')"
neg_a "NA9 Barriles con otra suscripcion" "insert into public.billing_subscriptions(tenant_id, plan_id, status) select '$B', id, 'CANCELLED' from public.billing_plans where key='starter'"
neg_a "NA10 tenant con otro nombre" "update public.tenants set name='Otro' where id='$B'"

echo "== A: flujo real A -> 170000 (el guard de 170000 aborta sin A)"
build_base
OUT=$($P -f "$MIG_170" 2>&1); RC=$?
chk "F0 sin A, 170000 aborta (por eso A va antes)" "$(b2s $([ $RC -ne 0 ] && echo true || echo false))"
build_base
$P -f "$MIG_A" >/dev/null 2>&1
OUT=$($P -f "$MIG_170" 2>&1); RC=$?
chk "F1 tras A, 170000 corre sin error y deja la Enterprise" \
  "$(b2s $([ $RC -eq 0 ] && echo true || echo false)) and (select count(*)=1 and bool_and(p.key='enterprise' and s.status='ACTIVE') from public.billing_subscriptions s join public.billing_plans p on p.id=s.plan_id where s.tenant_id='$B')"

echo "== A: mutaciones"
if [ -z "${NO_MUT:-}" ]; then
  mutA() { # $1 nombre, $2 expresion sed, $3 puerto
    perl -0pe "$2" "$MIGS/20261013165000_delete_barriles_business_subscription.sql" > "$WORK/mutA.sql"
    if cmp -s "$WORK/mutA.sql" "$MIGS/20261013165000_delete_barriles_business_subscription.sql"; then
      chk "$1: la mutacion se aplico" false; return
    fi
    NO_MUT=1 MIG_A_OVERRIDE="$WORK/mutA.sql" PGPORT_TEST=$3 "$0" > "$WORK/mutA.out" 2>&1; local rc=$?
    echo "   $1 -> exit $rc: $(grep RESUMEN "$WORK/mutA.out")"
    chk "$1: la prueba falla con la migracion mutada (exit 1)" "$(b2s $([ $rc -eq 1 ] && echo true || echo false))"
  }
  mutA "MA1 sin la guarda de factura PENDING" "s/i\.status <> .PENDING./false/" 54392
  mutA "MA2 sin la guarda de intentos de pago" "s/or exists \(select 1 from public\.payment_attempts a where a\.invoice_id = i\.id\)//" 54393
  mutA "MA3 sin la guarda de modulos negociados" "s/(billing_subscription_modules where subscription_id = c_sub;\n\s*)if v_n <> 0 then/\$1if false then/" 54394
fi
