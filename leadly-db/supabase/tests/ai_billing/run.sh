#!/usr/bin/env bash
# Pruebas puras de las herramientas de IA de entrega/facturación (sin base). Incluye 5 mutaciones que DEBEN fallar.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); FN="$HERE/../../functions"
T="$HERE/ai_billing_test.ts"; M="$FN/_shared/ai/deliveryBillingTools.ts"
RUN() { deno run -A "$T"; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
echo "== suite real"; RUN | grep -E "^FAIL|RESUMEN"; real=${PIPESTATUS[0]}
mut() { # nombre archivo-origen sed-expr var
  local name=$1 src=$2 expr=$3 var=$4 out="$(dirname "$2")/_mut_$1.ts"
  sed "$expr" "$src" > "$out"
  cmp -s "$src" "$out" && { echo "FAIL mutacion $name no aplico"; exit 2; }
  echo "== MUTACION $name"; env "$var=$out" deno run -A "$T" > "$W/m.txt" 2>&1; local rc=$?; grep -E "^FAIL|RESUMEN|SyntaxError" "$W/m.txt" | head -4; rm -f "$out"; return $rc
}
mut M1-gate-siempre-exige-direccion "$M" 's/const isDelivery = .*/const isDelivery = true;/' MODULE_PATH; m1=$?
mut M2-gate-siempre-exige-factura "$M" 's/if (input.invoiceRequested) {/if (true) {/' MODULE_PATH; m2=$?
mut M3-sin-eleccion-por-option "$M" 's/option !== null ? items.find/false ? items.find/' MODULE_PATH; m3=$?
mut M4-documento-sin-enmascarar "$M" 's/return digits.length <= 4 ? "\*\*\*\*" : `\*\*\*\*${digits.slice(-3)}`;/return digits;/' MODULE_PATH; m4=$?
mut M6-solo-nombre-exacto "$M" 's/isSubset(wanted, baseTokens(c.name))/false/' MODULE_PATH; m6=$?
mut M7-sin-exigir-correo "$M" 's/return \[...base, ...captureEmailMissing(row.email)\];/return base;/' MODULE_PATH; m7=$?
mut M5-vuelve-is_billing "$FN/whatsapp-ai-tools/index.ts" 's/^const CATALOG_SEARCH_LIMIT = 15;/const CATALOG_SEARCH_LIMIT = 15; const x = { is_billing: true };/' INDEX_PATH; m5=$?
echo "exit real=$real m1=$m1 m2=$m2 m3=$m3 m4=$m4 m5=$m5 m6=$m6 m7=$m7"
if [ "$real" -eq 0 ] && [ $m1 -ne 0 ] && [ $m2 -ne 0 ] && [ $m3 -ne 0 ] && [ $m4 -ne 0 ] && [ $m5 -ne 0 ] && [ $m6 -ne 0 ] && [ $m7 -ne 0 ]; then echo "RESULTADO OK"; exit 0; fi
echo "RESULTADO FALLA"; exit 1
