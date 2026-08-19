-- A superadmin can mark a payment_invoices row as paid outside Wompi (bank
-- transfer, cash, etc.) -- see record_manual_payment below. That path needs
-- its own payment_providers row so payment_attempts.provider_key (which FKs
-- to this table) can record "manual" as legitimately as "wompi" does.
insert into public.payment_providers (key, name) values ('manual', 'Pago manual');
