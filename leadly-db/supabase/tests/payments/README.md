# Pruebas SQL del esquema `payments` (P1)

Correr: `leadly-db/supabase/tests/payments/run.sh [directorio_de_trabajo]`

Levanta un Postgres 15 descartable (Homebrew `postgresql@15`, puerto 54329), crea la base `ptest`, simula roles
(`anon`, `authenticated`, `service_role`) y los esquemas `vault`/`net`/`cron` con stubs (`00_stubs.sql`), aplica la
migración `20261011190000_payments_schema.sql` DOS veces (idempotencia) y ejecuta:

- `10_functional.sql` reglas de negocio, aislamiento por proyecto, backoff, redacción, cron, secretos (como `service_role`).
- `20_security.sql` privilegios, RLS sin policies, tablas solo-insertar, 0 dependencias hacia `public`.
- `30..35_*` concurrencia con `pgbench` (begin_link, claim_deliveries, record_event).

No toca ninguna base real. Los stubs NO forman parte de la migración.
