#!/usr/bin/env bash
# Prueba 20261013120000_delete_fake_subscription_invoices.sql en un Postgres 15
# descartable (NO toca ninguna base real). Uso: tests/delete_fake_invoices/run.sh
set -euo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG="$HERE/../../migrations/20261013120000_delete_fake_subscription_invoices.sql"
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54332}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null; rm -rf "$WORK"' EXIT
P="$PGBIN/psql -X -q -t -A"
$P -c "create database t" >/dev/null; export PGDATABASE=t
reset() { $P -v ON_ERROR_STOP=1 -f "$HERE/stubs.sql" >/dev/null; }
run() { $P -f "$MIG" 2>&1 | sed -E 's/^psql:[^ ]+ //' | grep -E 'NOTICE|ERROR' || true; }
state() { $P -c "select 'invoices='||(select count(*) from payment_invoices)||' items='||(select count(*) from payment_invoice_items)||' attempts='||(select count(*) from payment_attempts)||' subs='||(select count(*) from billing_subscriptions)||' sales_invoices='||(select count(*) from sales_invoices)||' sexta_viva='||exists(select 1 from payment_invoices where id='66666666-6666-6666-6666-666666666666')"; }
FAKE=c22b2fca-6ebf-47cb-bfdf-646494519626

echo "== (i) borra las 5 + hijos; sobreviven suscripciones, sales_invoices y la 6a"; reset; state; run; state
echo "== (ii) idempotente (2a corrida)"; run; state
echo "== (iii) ABORTA si una tiene provider_transaction_id"; reset
$P -c "update payment_invoices set provider_transaction_id='tx' where id='$FAKE'"; run; state
echo "== (iii-b) ABORTA si un attempt tiene provider_transaction_id"; reset
$P -c "update payment_attempts set provider_transaction_id='tx' where invoice_id='$FAKE'"; run; state
echo "== (iv) ABORTA si una tiene payer_tenant_id distinto"; reset
$P -c "update payment_invoices set payer_tenant_id='22222222-2222-2222-2222-222222222222' where id='$FAKE'"; run; state
echo "== (v) ABORTA si el monto es distinto"; reset
$P -c "update payment_invoices set amount_cents=100 where id='$FAKE'"; run; state
