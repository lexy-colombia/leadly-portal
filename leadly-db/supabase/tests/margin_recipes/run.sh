#!/usr/bin/env bash
# Prueba 20261028130000_reports_margin_recipe_cost.sql en un Postgres 15 descartable con un esquema MINIMO
# (solo las tablas que la RPC lee). Uso: tests/margin_recipes/run.sh ; NO_MUT=1 omite mutaciones.
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG=${MIG:-$HERE/../../migrations/20261028130000_reports_margin_recipe_cost.sql}
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54437}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null || exit 2
trap '"$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1; rm -rf "$WORK"' EXIT
PSQL="$PGBIN/psql -X -q -t -A"
run() { # migracion-file -> imprime resultados, exit 1 si hay FAIL
  local mig=$1 db=$2
  $PSQL -d postgres -c "create database $db" >/dev/null
  PGDATABASE=$db $PSQL -v ON_ERROR_STOP=1 -f "$HERE/00_schema.sql" >/dev/null || { echo "FAIL schema"; return 2; }
  PGDATABASE=$db $PSQL -v ON_ERROR_STOP=1 -f "$mig" >/dev/null || { echo "FAIL migracion"; return 2; }
  PGDATABASE=$db $PSQL -f "$HERE/10_tests.sql" 2>&1
}
OUT=$(run "$MIG" t0); echo "$OUT"
np=$(echo "$OUT" | grep -c '^PASS'); nf=$(echo "$OUT" | grep -c '^FAIL')
echo "RESUMEN $np PASS, $nf FAIL"; [ "$nf" -ne 0 ] || [ "$np" -eq 0 ] && exit 1
if [ -z "${NO_MUT:-}" ]; then
  echo "== mutaciones (cada una debe dar FAIL)"
  i=0
  while IFS='|' read -r desc expr; do
    i=$((i+1)); sed -E "$expr" "$MIG" > "$WORK/m$i.sql"
    if cmp -s "$MIG" "$WORK/m$i.sql"; then echo "MUT $i NO-OP ($desc)"; exit 1; fi
    o=$(run "$WORK/m$i.sql" "tm$i"); n=$(echo "$o" | grep -c '^FAIL')
    [ "$n" -gt 0 ] && echo "MUT $i OK ($desc): $n FAIL" || { echo "MUT $i SOBREVIVIO ($desc)"; exit 1; }
  done <<'MUTS'
sin tenant en join product_bom|s/pb.product_id = p.id and pb.tenant_id = p_tenant_id/pb.product_id = p.id/
sin tenant en join materials|s/m.id = pb.material_id and m.tenant_id = p_tenant_id/m.id = pb.material_id/
insumo en 0 cuenta como conocido|s/bool_or\(m.id is null or m.cost = 0\)/bool_or(m.id is null)/
excluye insumo retirado|s/and m.tenant_id = p_tenant_id$/and m.tenant_id = p_tenant_id and m.deleted_at is null/
MUTS
fi
exit 0
