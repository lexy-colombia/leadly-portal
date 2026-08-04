-- Enables Realtime (postgres_changes) for the tenant Inbox: new inbound
-- messages and conversation mode/last_message_at updates need to reach the
-- panel without polling. RLS on both tables already scopes rows to the
-- caller's own tenant (or superadmin), and Realtime's postgres_changes
-- respects RLS, so no extra authorization logic is needed here.
alter publication supabase_realtime add table public.whatsapp_conversations;
alter publication supabase_realtime add table public.whatsapp_messages;
