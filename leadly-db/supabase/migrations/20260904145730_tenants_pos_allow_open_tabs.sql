-- Interruptor opt-in por tenant: apagado (default), /app/pos se comporta
-- exactamente como hoy (venta rápida de un solo viaje, pos-checkout).
-- Encendido, /app/pos pasa al modo de cuentas abiertas.
alter table public.tenants add column pos_allow_open_tabs boolean not null default false;
