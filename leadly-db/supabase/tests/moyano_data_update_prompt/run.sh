#!/usr/bin/env bash
# Prueba 20261013200000_moyano_prompt_contact_data_update.sql en un Postgres 15 descartable
# (NO toca ninguna base real). Fixture: respaldo del system_prompt de produccion 2026-10-13.
# Al final corre una MUTACION (quita los chequeos de frase de origen) y exige que la prueba falle.
# Uso: ./run.sh -> "RESUMEN N PASS, M FAIL"; exit != 0 ante cualquier fallo.
set -uo pipefail
PGBIN=${PGBIN:-/opt/homebrew/opt/postgresql@15/bin}
HERE=$(cd "$(dirname "$0")" && pwd)
MIG="${MIG_OVERRIDE:-$HERE/../../migrations/20261013200000_moyano_prompt_contact_data_update.sql}"
FIX="$HERE/fixture_prompt.txt"
WORK=$(mktemp -d); PORT=${PGPORT_TEST:-54352}
export PGHOST=127.0.0.1 PGPORT=$PORT PGUSER=postgres PGDATABASE=postgres
"$PGBIN/initdb" -D "$WORK/data" -U postgres --auth=trust >/dev/null || exit 2
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$WORK" -l "$WORK/pg.log" -w start >/dev/null || exit 2
trap '"$PGBIN/pg_ctl" -D "$WORK/data" -m fast stop >/dev/null 2>&1; rm -rf "$WORK"' EXIT
P="$PGBIN/psql -X -q -t -A"
$P -c "create database ptest" >/dev/null || { echo "RESUMEN 0 PASS, 1 FAIL (createdb)"; exit 1; }
export PGDATABASE=ptest

A=9ce9415a-4f24-4092-ac96-6e311c48df68; T=7419c825-4d72-45af-bf40-73375eed9f9c
OTHER_T=11111111-1111-1111-1111-111111111111

# $1 = migracion; $2 = filtro sed opcional aplicado al prompt de Moyano (para romper frases de origen)
reset() {
  local sedexpr="${1:-}"
  local body; body=$(cat "$FIX")
  [ -n "$sedexpr" ] && body=$(printf '%s' "$body" | sed -E "$sedexpr")
  $P -v "p=$body" >/dev/null <<SQL
drop table if exists public.ai_assistants;
create schema if not exists public;
create table public.ai_assistants(id uuid primary key, tenant_id uuid not null, name text, system_prompt text, updated_at timestamptz default now());
insert into public.ai_assistants(id, tenant_id, name, system_prompt) values
 ('$A','$T','Moyano', :'p'),
 (gen_random_uuid(),'$T','Hermano mismo tenant', :'p'),
 (gen_random_uuid(),'$OTHER_T','Otro tenant, mismo texto', :'p'),
 ('22222222-2222-2222-2222-222222222222','$OTHER_T','Otro', 'Prompt de otro tenant sin nada');
SQL
}
runmig() { $P -v ON_ERROR_STOP=1 -f "$1" >/dev/null 2>"$WORK/err.txt"; echo $?; }
q() { $P -c "$1"; }

PASS=0; FAIL=0
ck() { # nombre, expresion SQL booleana
  local r; r=$(q "select coalesce(($2), false)")
  if [ "$r" = "t" ]; then PASS=$((PASS+1)); echo "PASS $1"; else FAIL=$((FAIL+1)); echo "FAIL $1 (valor: $r)"; fi
}
ckrc() { # nombre, rc obtenido, condicion ('zero'|'nonzero')
  if { [ "$3" = zero ] && [ "$2" = 0 ]; } || { [ "$3" = nonzero ] && [ "$2" != 0 ]; }; then PASS=$((PASS+1)); echo "PASS $1 (exit $2)"; else FAIL=$((FAIL+1)); echo "FAIL $1 (exit $2)"; cat "$WORK/err.txt"; fi
}
PM="(select system_prompt from public.ai_assistants where id='$A')"

suite_main() {
  echo "== caso 1: aplica bien"
  reset
  q "create temp table x as select 1" >/dev/null
  $P -c "create table public.snap as select id, md5(system_prompt) h, system_prompt from public.ai_assistants" >/dev/null
  rc=$(runmig "$MIG"); ckrc "migracion aplica (exit 0)" "$rc" zero
  ck "prompt crecio" "length($PM) > (select length(system_prompt) from public.snap where id='$A')"
  ck "seccion 5 presente" "position('## 5. Actualizar datos de contacto' in $PM) > 0"
  ck "seccion justo antes de '# Lo que NO puedes hacer'" "position('## 5. Actualizar datos de contacto' in $PM) < position(E'\n# Lo que NO puedes hacer\n' in $PM) and position('## 5. Actualizar datos de contacto' in $PM) > position('## 4. Asociar personas' in $PM)"
  ck "linea 'No uses flag_interest_for_followup: no aplica a este negocio.' sigue intacta" "position('- No uses flag_interest_for_followup: no aplica a este negocio.' in $PM) > 0"

  echo "== caso 2: fuera de los dos puntos es identico (comparacion independiente)"
  $P -c "create temp table _ as select 1" >/dev/null
  ck "prefijo y sufijo identicos al original (unico cambio = insercion de la seccion)" "
    with o as (select system_prompt om from public.snap where id='$A'),
    pos as (select om, position(E'
# Lo que NO puedes hacer
' in om) p from o)
    select left($PM, p) = left(om, p)
       and right($PM, length(om) - p) = right(om, length(om) - p)
       and length($PM) > length(om)
    from pos"

  echo "== caso 3: contenido de la seccion"
  SEC="(select substr($PM, position('## 5. Actualizar datos' in $PM), position(E'\n# Lo que NO puedes hacer' in $PM) - position('## 5. Actualizar datos' in $PM)))"
  ck "3 botones exactos" "$SEC like '%\"Actualizar mis datos\"%' and $SEC like '%\"Más tarde\"%' and $SEC like '%\"No deseo recibir mensajes\"%'"
  ck "herramientas permitidas presentes (get_client_profile, update_client_profile)" "$SEC like '%get_client_profile%' and $SEC like '%update_client_profile%'"
  ck "seccion NO nombra flag_interest_for_followup ni crea tareas" "$SEC !~* 'flag_interest|tarea|create_opportunity|create_task|create_note'"
  ck "reglas c/f/'mas tarde': ninguna herramienta, sin capturar telefono" "$SEC like '%No uses ninguna herramienta y no insistas%' and $SEC like '%y no uses ninguna herramienta.%' and $SEC like '%no lo captures ni lo guardes%'"
  DNC="(select l from regexp_split_to_table($SEC, E'\\n') l where l like '- *No deseo recibir mensajes*%')"
  ck "'No deseo': llama update_client_profile con do_not_contact=true una sola vez, sin otros campos" "$DNC like '%llama UNA sola vez update_client_profile con do_not_contact=true, sin ningún otro campo%'"
  ck "'No deseo': despedida condicionada a la confirmacion y dice 'quedó registrada' + la administracion la tendra en cuenta" "$DNC like '%Solo si la herramienta confirma do_not_contact=true%' and $DNC like '%su solicitud quedó registrada y que la administración la tendrá en cuenta%'"
  ck "'No deseo': prohibicion explicita de prometer que no recibira mas mensajes" "$DNC like '%PROHIBIDO prometer que \"no le escribirán más\", que \"no recibirá más mensajes\"%'"
  ck "'No deseo': fuera de la prohibicion NO hay promesa de no recibir mas mensajes" "split_part($DNC, 'PROHIBIDO', 1) !~* 'no recibir[aá] m[aá]s|no le escribir[aá]n|no se le enviar[aá]n|dejar[aá] de recibir|ya no (le|te) (escribir|enviar)' and $SEC !~* 'asegúrale que no|confírmale que no se le'"
  ck "'No deseo': si falla, disculpa y la administracion lo atendera" "$DNC like '%Si la herramienta falla, discúlpate y dile que la administración lo atenderá%'"
  ck "do_not_contact solo en la linea 'No deseo' (1 aparicion de la llamada, 1 de la confirmacion)" "(length($SEC) - length(replace($SEC, 'do_not_contact', ''))) / length('do_not_contact') = 2"
  ck "no hay otra etiqueta ni nombre de tag en la seccion" "$SEC !~* 'etiqueta|tags|administrador'"
  ck "unica vez que aparece 'no contactar' como texto: ninguna (la etiqueta la pone el servidor)" "$SEC !~* 'no contactar'"
  ck "solo nombres de herramienta permitidos (tokens snake_case)" "not exists (select 1 from regexp_matches($SEC, '[a-z]+_[a-z_]+', 'g') m where m[1] not in ('get_client_profile','update_client_profile','full_name','do_not_contact'))"
  ck "sin create_note/set_lead_stage/create_pqr" "$SEC !~ 'create_note|set_lead_stage|create_pqr|send_attachment'"
  ck "sin doble asterisco en la seccion" "position('**' in $SEC) = 0"
  ck "sin titulos # extra en la seccion (solo la cabecera)" "(select count(*) from regexp_split_to_table($SEC, E'\n') l where l ~ '^#') = 1"
  ck "sin enlaces markdown" "$SEC !~ '\\]\\(http'"
  ck "prioridad sobre 'Primer mensaje'" "$SEC like '%prioridad sobre la regla de \"Primer mensaje de la conversación\"%'"
  ck "no pide telefono" "$SEC like '%No pidas un teléfono%'"

  echo "== caso 4: otros asistentes intactos (huella md5)"
  ck "los otros 3 asistentes sin cambios" "(select count(*) from public.ai_assistants a join public.snap s using(id) where a.id <> '$A' and md5(a.system_prompt) = s.h) = 3"

  echo "== caso 5: idempotente (2a y 3a corrida)"
  H1=$(q "select md5(system_prompt) from public.ai_assistants where id='$A'")
  rc=$(runmig "$MIG"); ckrc "2a corrida exit 0" "$rc" zero
  rc=$(runmig "$MIG"); ckrc "3a corrida exit 0" "$rc" zero
  ck "prompt igual tras re-correr" "md5($PM) = '$H1'"

  echo "== caso 6: aborta sin escribir si falta una frase de origen"
  for spec in \
    "linea_flag|s/No uses flag_interest_for_followup: no aplica a este negocio\./No uses flag_interest_for_followup./" \
    "ancla|s/# Lo que NO puedes hacer/# Lo que no puedes hacer/" \
    "primer_mensaje|s/Primer mensaje de la conversación/Primer mensaje/" \
    "peticion_concreta|s/atiéndela de una vez, sin menú\./atiéndela./" \
    "datos_personales|s/con update_client_profile solo si él te lo da o te lo pide\./con update_client_profile./"; do
    nm=${spec%%|*}; ex=${spec#*|}
    reset "$ex"
    before=$(q "select md5(system_prompt) from public.ai_assistants where id='$A'")
    rc=$(runmig "$MIG"); ckrc "aborta sin $nm" "$rc" nonzero
    ck "no escribio sin $nm" "md5($PM) = '$before'"
  done
  echo "== caso 7: frase duplicada aborta"
  reset
  $P -c "update public.ai_assistants set system_prompt = system_prompt || E'\n- No uses flag_interest_for_followup: no aplica a este negocio.' where id='$A'" >/dev/null
  before=$(q "select md5(system_prompt) from public.ai_assistants where id='$A'")
  rc=$(runmig "$MIG"); ckrc "aborta con frase duplicada" "$rc" nonzero
  ck "no escribio con frase duplicada" "md5($PM) = '$before'"
  echo "== caso 8: asistente con otro tenant / inexistente aborta"
  reset
  $P -c "update public.ai_assistants set tenant_id='$OTHER_T' where id='$A'" >/dev/null
  rc=$(runmig "$MIG"); ckrc "aborta si el id no pertenece al tenant" "$rc" nonzero
  ck "no escribio (otro tenant)" "md5($PM) = md5((select system_prompt from public.ai_assistants where name='Hermano mismo tenant'))"
  echo "== caso 9: seccion a medias aborta"
  reset
  $P -c "update public.ai_assistants set system_prompt = replace(system_prompt, E'\n# Lo que NO puedes hacer\n', E'\n## 5. Actualizar datos de contacto (respuesta a la plantilla de la administración)\nparcial\n\n# Lo que NO puedes hacer\n') where id='$A'" >/dev/null
  rc=$(runmig "$MIG"); ckrc "aborta con seccion incompleta" "$rc" nonzero
}

suite_main
echo "== MUTACION: sin chequeos de frase de origen ni verificaciones, el caso 'falta frase' debe FALLAR"
perl -0pe 's/  -- Frases de origen:.*?(?=  v_new := replace\(v_old, c_anchor)//s; s/  -- Verificaciones post-cambio\..*?(?=  update public\.ai_assistants)//s' "$MIG" > "$WORK/mutant.sql"
if cmp -s "$MIG" "$WORK/mutant.sql"; then FAIL=$((FAIL+1)); echo "FAIL mutacion no aplico (patron no encontrado)"; else
  reset "s/# Lo que NO puedes hacer/# Lo que no puedes hacer/"
  before=$(q "select md5(system_prompt) from public.ai_assistants where id='$A'")
  rc=$(runmig "$WORK/mutant.sql")
  if [ "$rc" = 0 ]; then
    PASS=$((PASS+1)); echo "PASS mutacion detectada: sin chequeos la migracion termina exit 0 aunque falte la frase de origen (el caso 6 'aborta' fallaria) (la prueba del caso 6 fallaria)"
  else FAIL=$((FAIL+1)); echo "FAIL mutacion no detectada (rc=$rc)"; fi
fi
echo "RESUMEN $PASS PASS, $FAIL FAIL"
[ "$FAIL" -eq 0 ] && [ "$PASS" -gt 0 ]
