-- Recovered/reconstructed file (2026-08-09): this migration was applied
-- directly to the remote project on 2026-08-07 without a matching local
-- file ever being saved -- found and fixed while reconciling local
-- migration filenames against `list_migrations` so this repo doesn't
-- diverge from what's actually applied (see the batch of filename-only
-- renames alongside this file, same reconciliation pass). The exact
-- original SQL couldn't be recovered, so this reconstructs the intent from
-- its name and the current (still-flagged) advisor findings: same pattern
-- as 20260802000010_function_privilege_hardening.sql, applied to the
-- payment/billing SECURITY DEFINER functions added the same day. All
-- `revoke`s are idempotent no-ops if already applied, so running this again
-- is safe regardless of what the original migration actually did.
--
-- get_payment_credential_secret is only ever called by service_role (see
-- _shared/payments/registry.ts) -- revoke from both anon and authenticated.
-- set_payment_credential_secret / payment_credential_configured_secrets are
-- called from the tenant's own authenticated session (lib/api/billing.ts)
-- -- keep authenticated, revoke anon only.
-- activate_subscription_on_invoice_paid / process_recurring_billing_invoices
-- are trigger/cron-internal, never called via RPC from the app -- revoke
-- from both anon and authenticated.
revoke execute on function public.get_payment_credential_secret(uuid, text) from anon, authenticated;
revoke execute on function public.set_payment_credential_secret(uuid, text, text) from anon;
revoke execute on function public.payment_credential_configured_secrets(uuid) from anon;
revoke execute on function public.activate_subscription_on_invoice_paid() from anon, authenticated;
revoke execute on function public.process_recurring_billing_invoices() from anon, authenticated;
