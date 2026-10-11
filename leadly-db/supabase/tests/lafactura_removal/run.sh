#!/usr/bin/env bash
# Prueba la migracion 20261011200000_remove_lafactura_integration.sql en un Postgres 15
# descartable (NO toca ninguna base real). Uso: tests/lafactura_removal/run.sh
set -euo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG="$HERE/../../migrations/20261011200000_remove_lafactura_integration.sql"
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54331}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null; rm -rf "$WORK"' EXIT
P="$PGBIN/psql -X -q -t -A"
$P -c "create database t" >/dev/null; export PGDATABASE=t
reset() { $P -v ON_ERROR_STOP=1 -f "$HERE/stubs.sql" >/dev/null; }
run() { $P -f "$MIG" 2>&1 | sed -E 's/^psql:[^ ]+ //' | grep -E 'NOTICE|ERROR' || true; }
state() { $P -c "select 'providers='||(select string_agg(key,',' order by key) from integration_providers)||' creds='||(select string_agg(provider_key||':'||coalesce(tenant_id::text,'null'),',' order by provider_key,id) from integration_credentials)||' secrets='||(select count(*) from integration_credential_secrets)"; }

echo "== (i) borra credencial+proveedor, deja intactos los demas"; reset; state; run; state
echo "== (ii) idempotente (2a corrida)"; run; state
echo "== (iii) ABORTA con credencial lafactura de tenant"; reset
$P -c "insert into integration_credentials(tenant_id,provider_key) values ('11111111-1111-1111-1111-111111111111','lafactura')"; run; state
echo "== (iv) ABORTA con secreto asociado"; reset
$P -c "insert into integration_credential_secrets(credential_id,secret_name,secret_id) select id,'api_user',gen_random_uuid() from integration_credentials where provider_key='lafactura'"; run; state
echo "== (v) ABORTA si otra tabla con FK referencia la credencial"; reset
$P -c "create table other_ref(cred_id uuid references integration_credentials(id)); insert into other_ref select id from integration_credentials where provider_key='lafactura'"; run; state
