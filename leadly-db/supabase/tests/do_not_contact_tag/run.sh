#!/usr/bin/env bash
# Pruebas de update_client_profile.do_not_contact (logica pura + cliente falso; NO toca ninguna base).
# Incluye 2 mutaciones que DEBEN hacer fallar la prueba (exit 1).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
FN="$HERE/../../functions"
T="$HERE/do_not_contact.test.ts"
RUN() { deno run --allow-read --allow-env "$T"; }
echo "== suite real"; RUN; real=$?
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
echo "== MUTACION 1: el modelo elige el texto de la etiqueta (parameters.tag)"
sed 's/\[\.\.\.tags, DO_NOT_CONTACT_TAG\]/[...tags, String((globalThis as any).__p?.tag ?? DO_NOT_CONTACT_TAG)]/' "$FN/_shared/clientTags.ts" > "$W/clientTags.ts"
python3 - "$W/clientTags.ts" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
# el helper mutante toma el nombre de parameters.tag cuando existe
s=s.replace('const doNotContact = parameters.do_not_contact === true;','(globalThis as any).__p = parameters;\n  const doNotContact = parameters.do_not_contact === true;')
open(p,'w').write(s)
PY
cmp -s "$FN/_shared/clientTags.ts" "$W/clientTags.ts" && { echo "FAIL mutacion 1 no aplico"; exit 2; }
TAGS_PATH="$W/clientTags.ts" RUN >"$W/m1.txt"; m1=$?; grep -E "^FAIL|RESUMEN" "$W/m1.txt"
echo "== MUTACION 2: do_not_contact truthy ('true' string) activa la etiqueta"
sed 's/parameters.do_not_contact === true/!!parameters.do_not_contact/' "$FN/_shared/clientTags.ts" > "$W/clientTags2.ts"
cmp -s "$FN/_shared/clientTags.ts" "$W/clientTags2.ts" && { echo "FAIL mutacion 2 no aplico"; exit 2; }
TAGS_PATH="$W/clientTags2.ts" RUN >"$W/m2.txt"; m2=$?; grep -E "^FAIL|RESUMEN" "$W/m2.txt"
echo "exit real=$real mutacion1=$m1 mutacion2=$m2 (mutaciones deben ser != 0)"
if [ "$real" -eq 0 ] && [ "$m1" -ne 0 ] && [ "$m2" -ne 0 ]; then echo "RESULTADO OK"; exit 0; fi
echo "RESULTADO FALLA"; exit 1
