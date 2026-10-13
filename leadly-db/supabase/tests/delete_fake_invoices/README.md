# Prueba de 20261013120000_delete_fake_subscription_invoices.sql

`./run.sh` levanta un Postgres 15 efimero (puerto 54332, `PGBIN` configurable), carga `stubs.sql`
(forma minima de payment_invoices/items/attempts, billing_subscriptions, sales_invoices) y
ejecuta la migracion en 6 escenarios: borrado correcto, idempotencia y 4 abortos
(provider_transaction_id en factura, en intento, tenant distinto, monto distinto).
No toca ninguna base real.
