#!/usr/bin/env bash
# Prueba las migraciones de correccion de suscripciones (20261013165000 y 20261013190000)
# en un Postgres 15 descartable con las migraciones REALES. NO toca ninguna base real.
# Uso: ./run.sh -> "RESUMEN N PASS, M FAIL"; exit != 0 ante fallo.
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/lib.sh"
for part in "$HERE"/t_*.sh; do source "$part"; done
finish
