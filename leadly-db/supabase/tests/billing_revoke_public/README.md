# Prueba de 20261013140000_billing_functions_revoke_public

`./run.sh` levanta un Postgres 15 descartable, crea las tres funciones definer con el grant por
defecto (PUBLIC) y el revoke incompleto previo, y demuestra: antes anon puede ejecutarlas; despues
anon/authenticated/public no (llamada real con SET ROLE), service_role y el dueno si, el job como
dueno sigue funcionando (incluida la cadena deactivate -> mark_overdue), y es idempotente.
Imprime `RESUMEN N PASS, M FAIL`; exit != 0 si hay fallo. No toca ninguna base real.
