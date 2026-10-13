#!/usr/bin/env bash
# Prueba 20261013140000_billing_functions_revoke_public.sql en un Postgres 15 descartable
# (NO toca ninguna base real). Imprime "RESUMEN N PASS, M FAIL"; sale != 0 ante cualquier fallo.
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
NEW="${MIG_OVERRIDE:-$HERE/../../migrations/20261013140000_billing_functions_revoke_public.sql}"
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54351}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null || exit 2
trap '"$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1; rm -rf "$WORK"' EXIT
P="$PGBIN/psql -X -v ON_ERROR_STOP=1 -q -t -A"
$P -c "create database ptest" >/dev/null || { echo "RESUMEN 0 PASS, 1 FAIL (createdb)"; exit 1; }
export PGDATABASE=ptest
$P -f "$HERE/stubs.sql" >/dev/null || { echo "RESUMEN 0 PASS, 1 FAIL (stubs)"; exit 1; }

PASS=0; FAIL=0
ok()  { echo "PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $1"; FAIL=$((FAIL+1)); }
# can ROLE FN -> t/f via has_function_privilege ('public' = pseudo-rol)
can() { $P -c "select has_function_privilege('$1','public.$2()','execute')"; }
# call ROLE FN -> "ok" o "denied" (llamada real con SET ROLE)
call() { if out=$($P -c "set role $1; select public.$2()" 2>&1); then echo ok; else
  case "$out" in *"permission denied"*) echo denied;; *) echo "error: $out";; esac; fi; }
check() { # desc esperado obtenido
  if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1 (esperado $2, obtenido $3)"; fi; }

FNS="process_recurring_billing_invoices deactivate_tenants_with_overdue_invoices mark_overdue_invoices"
echo "== (i) ANTES de la migracion: anon/authenticated SI pueden (trampa PUBLIC)"
for f in $FNS; do
  check "antes: has_function_privilege anon $f" t "$(can anon $f)"
  check "antes: has_function_privilege authenticated $f" t "$(can authenticated $f)"
done
check "antes: llamada real SET ROLE anon process_recurring_billing_invoices" ok "$(call anon process_recurring_billing_invoices)"
check "antes: llamada real SET ROLE authenticated mark_overdue_invoices" ok "$(call authenticated mark_overdue_invoices)"

echo "== migracion (1a vez)"
$P -f "$NEW" >/dev/null || { echo "RESUMEN $PASS PASS, $((FAIL+1)) FAIL (migracion)"; exit 1; }

verify() {
  local tag=$1
  for f in $FNS; do
    for r in anon authenticated public; do
      check "$tag: $r NO puede $f" f "$(can $r $f)"
    done
    check "$tag: service_role SI puede $f" t "$(can service_role $f)"
    check "$tag: dueno postgres SI puede $f" t "$(can postgres $f)"
    check "$tag: llamada real anon denegada $f" denied "$(call anon $f)"
    check "$tag: llamada real authenticated denegada $f" denied "$(call authenticated $f)"
    check "$tag: llamada real service_role ok $f" ok "$(call service_role $f)"
  done
}
echo "== (ii)(iii) DESPUES de la migracion"
verify despues

echo "== (iv) job simulado como el dueno (cron corre como postgres)"
$P -c "truncate public.runs; update public.payment_invoices set status='PENDING'; update public.tenants set status='active'" >/dev/null
$P -c "select public.process_recurring_billing_invoices()" >/dev/null && ok "job process_recurring como dueno" || bad "job process_recurring como dueno"
$P -c "select public.deactivate_tenants_with_overdue_invoices()" >/dev/null && ok "job deactivate_... como dueno" || bad "job deactivate_... como dueno"
check "deactivate llamo internamente a mark_overdue_invoices" 1 "$($P -c "select count(*) from public.runs where fn='mark_overdue_invoices'")"
check "factura quedo OVERDUE por la cadena interna" OVERDUE "$($P -c "select status from public.payment_invoices limit 1")"
check "tenant desactivado por el job" inactive "$($P -c "select status from public.tenants limit 1")"

echo "== (v) idempotencia (2a y 3a vez)"
$P -f "$NEW" >/dev/null && $P -f "$NEW" >/dev/null && ok "re-ejecucion sin error" || bad "re-ejecucion sin error"
verify idempotente

echo "== funcion ausente: NOTICE y sigue con las demas"
$P -c "drop function public.mark_overdue_invoices() cascade" >/dev/null
OUT=$($P -f "$NEW" 2>&1); RC=$?
check "migracion con funcion ausente termina bien" 0 "$RC"
case "$OUT" in *"mark_overdue_invoices() no existe"*) ok "NOTICE de funcion ausente emitido";; *) bad "NOTICE de funcion ausente emitido: $OUT";; esac
check "las otras siguen revocadas (anon deactivate)" f "$(can anon deactivate_tenants_with_overdue_invoices)"

echo "RESUMEN $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ] && [ "$PASS" -gt 0 ]
