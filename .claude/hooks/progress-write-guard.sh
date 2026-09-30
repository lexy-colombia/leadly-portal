#!/bin/bash
# PreToolUse(Write) para agentes read-only (reviewer, explorer).
# Se engancha POR AGENTE, en el frontmatter de .claude/agents/{reviewer,explorer}.md
# — no globalmente: el implementer sí debe poder escribir en apps/ y supabase/.
#
# Permite escrituras solo dentro de progress/. Bloquea el resto con exit 2.
#
# Complementa a write-guard.sh, que es el guard UNIVERSAL de rutas (andamiaje
# temporal en directorios de test, inmutabilidad de progress/archive/, nada de
# secretos hardcodeados) enganchado en .claude/settings.json para todos los
# agentes -- el implementer sí necesita escribir en leadly-app/ y leadly-db/,
# por eso esa restricción de "solo progress/" va aparte, por agente.
set -euo pipefail

INPUT="$(cat)"

FILE="$(printf '%s' "$INPUT" | /usr/bin/python3 -c \
  'import json,sys; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))' \
  2>/dev/null || true)"

# No file path -> nothing to guard.
[ -z "$FILE" ] && exit 0

case "$FILE" in
  */progress/*|progress/*)
    exit 0
    ;;
  *)
    echo "Bloqueado: este agente solo puede escribir dentro de progress/ (intento: $FILE)" >&2
    exit 2
    ;;
esac
