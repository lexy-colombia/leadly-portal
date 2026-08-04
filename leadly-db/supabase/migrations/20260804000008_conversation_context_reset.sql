-- Marks the point from which the AI should build its context. Closing a
-- conversation is a deliberate "this is done" signal from the tenant; if the
-- contact writes again later (or an agent proactively reopens it to write
-- first), it should feel like a fresh start to the AI -- not drag in
-- everything said before the close. Full history stays visible in the CRM
-- either way (the contact detail / chat log never hides anything); this only
-- changes what whatsapp-ai-respond feeds the model. NULL means "use the
-- whole history", so every existing conversation keeps behaving exactly as
-- before this migration.
alter table public.whatsapp_conversations add column context_reset_at timestamptz;
