-- "Notas internas" card on the Empresa detail screen -- crm_accounts had no
-- free-text field for this (unlike tenants.notes, which already exists for
-- the analogous backoffice screen).
alter table public.crm_accounts add column notes text;
