# Harness de paridad del motor DIAN (S0)

Correr (desde la raíz del repo): `deno test -A leadly-db/supabase/tests/invoicing/`

- `cufe_oracle_test.ts` — algoritmo CUFE/CUDE contra los XML oficiales de la DIAN (sin secretos).
- `parity_test.ts` — fixtures sintéticos (+ reales si existen) -> builders -> hash independiente -> totales -> firma con cert autofirmado.
- `snapshots/` — XML sin firmar de los fixtures sintéticos. Regenerar a propósito con `S0_UPDATE_SNAPSHOTS=1`.
- `export_fixtures.sql` — SQL de SOLO LECTURA para exportar facturas aceptadas reales a `progress/fixtures_private/*.json` (git-ignorado).

No escribe en DB, no transmite, no usa el .p12 real. `harness.ts` duplica el mapeo fila->input de
`sendInvoiceToDian.ts`/`sendCreditNoteToDian.ts`: si cambia allá, actualizarlo acá.

> **Nota (2026-10-10):** los scripts `s1_*` (`s1_preflight_legacy.sql`, `s1_verify_backfill.sql`, `s1_verify_issue_dates_from_xml.ts`) requieren el esquema `invoicing`, retirado el 2026-10-10 (migración `20261010120000_drop_invoicing_schema.sql`); se conservan para cuando se retome (`progress/feature_invoicing_api.md`). El harness de paridad (`cufe_oracle_test.ts`, `parity_test.ts`) no depende del esquema y sigue vigente.
