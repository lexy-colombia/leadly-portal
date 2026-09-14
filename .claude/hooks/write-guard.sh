#!/bin/bash
# PreToolUse(Write|Edit) — guard de rutas para TODOS los agentes.
#
# Adaptado de mi-saldo/saldoapp-web (mismo problema, distinto stack): un
# archivo de andamiaje temporal que nadie borra y que además coincide con el
# patrón de test del runner corre en cada ejecución y reporta verde sin
# verificar nada. Este proyecto (leadly-app, Vite+React) no tiene hoy ningún
# test runner instalado -- la regla igual se deja activa para el día que
# aparezca uno, y cubre de paso cualquier script Deno de prueba que alguien
# deje en leadly-db/supabase/functions con un nombre de andamiaje.
#
# Estas reglas son universales (no dependen de qué agente escriba) y por eso se
# enganchan globalmente sin bloquear al implementer, que sí necesita escribir
# en leadly-app/src y leadly-db/supabase.
set -euo pipefail

INPUT="$(cat)"

FILE="$(printf '%s' "$INPUT" | /usr/bin/python3 -c \
  'import json,sys; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))' \
  2>/dev/null || true)"

[ -z "$FILE" ] && exit 0

BASE="$(basename "$FILE")"

# --- Regla 1: nada de andamiaje temporal dentro de directorios de test --------
case "$FILE" in
  */test/*|test/*|*/tests/*|tests/*|*/__tests__/*|*/e2e/*)
    case "$BASE" in
      tmp_*|temp_*|scratch_*|dump_*|_tmp*)
        cat >&2 <<MSG
Bloqueado: '$BASE' es andamiaje temporal y no puede vivir en un directorio de test.

  Un archivo tmp_*.test.ts (o *.spec.ts) corre en cada ejecución de la suite
  y reporta verde sin verificar nada real.

  Usa el directorio scratchpad de la sesión para verificaciones desechables.
  Si el archivo SÍ es un test de verdad, nómbralo por lo que prueba.
MSG
        exit 2
        ;;
    esac
    ;;
esac

# --- Regla 2: progress/archive/ es historia, es inmutable ---------------------
case "$FILE" in
  */progress/archive/*|progress/archive/*)
    cat >&2 <<MSG
Bloqueado: progress/archive/ es evidencia histórica fechada, no se edita.

  Si necesitas cambiar una decisión, va en progress/DECISIONES_<slug>.md
  mientras la feature está en curso (se disuelve en CLAUDE.md al cerrar).
  Si necesitas registrar dónde va el trabajo, va en progress/ESTADO.md.
MSG
    exit 2
    ;;
esac

# --- Regla 3: nunca un secreto hardcodeado fuera de env/Vault -----------------
# Defensa en profundidad, no el único chequeo: un service_role/token pegado a
# mano en código que llega al bundle del cliente o al repo de Edge Functions.
# Los secretos de integración van a Supabase Vault o `supabase secrets set`,
# nunca a leadly-app/src/** ni a leadly-db/supabase/functions/** como literal.
case "$FILE" in
  */leadly-app/src/*|leadly-app/src/*|*/leadly-db/supabase/functions/*|leadly-db/supabase/functions/*)
    case "$BASE" in
      .env|.env.*)
        echo "Bloqueado: '$BASE' no va dentro del código -- variables de entorno fuera de git." >&2
        exit 2
        ;;
    esac
    ;;
esac

# La restricción "reviewer/explorer solo escriben en progress/" NO vive aquí:
# se engancha por agente (frontmatter de .claude/agents/*.md) vía
# progress-write-guard.sh, que es el mecanismo correcto porque este hook es
# global y el implementer sí necesita escribir en leadly-app/**, leadly-db/**.

exit 0
