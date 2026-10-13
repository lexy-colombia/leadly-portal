# Prueba de la migracion remove_lafactura_integration

`./run.sh` levanta un Postgres 15 descartable (initdb en un directorio temporal, se borra al salir),
crea `stubs.sql` (la forma real de integration_providers/credentials/secrets de 20260811000013) y
corre `migrations/20261011200000_remove_lafactura_integration.sql` en 5 escenarios:
borrado limpio, idempotencia, aborta con credencial de tenant, aborta con secreto, aborta con FK ajena.
No toca ninguna base real.
