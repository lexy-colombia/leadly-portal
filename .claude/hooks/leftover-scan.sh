#!/bin/bash
# Stop / SubagentStop — red de seguridad para andamiaje temporal.
#
# write-guard.sh solo ve Write/Edit. Un archivo creado con `cat > ...` desde
# Bash se le escapa. Este scan corre al terminar y avisa. No bloquea: informa.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

LEFTOVERS="$(find leadly-app/src leadly-db/supabase/functions -type f \
  \( -path '*/test/*' -o -path '*/tests/*' -o -path '*/__tests__/*' -o -path '*/e2e/*' \) \
  \( -name 'tmp_*' -o -name 'temp_*' -o -name 'scratch_*' -o -name '_tmp*' \) 2>/dev/null || true)"

if [ -n "$LEFTOVERS" ]; then
  {
    echo "⚠️  Quedó andamiaje temporal en un directorio de test — bórralo o muévelo al scratchpad:"
    printf '%s\n' "$LEFTOVERS" | sed 's/^/    /'
    echo "    (un tmp_*.test.ts corre en cada ejecución de la suite y reporta verde sin verificar nada)"
  } >&2
fi

exit 0
