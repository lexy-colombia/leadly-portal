-- Lets a tenant hide a conversation from the main Inbox without deleting its
-- history -- distinct from `status` (open/closed, about who's currently
-- responding). Nullable timestamp instead of a boolean, same pattern as
-- context_reset_at/reminder_sent_at elsewhere in this schema: null = not
-- archived, set = when it was archived. No new RLS needed -- the existing
-- whatsapp_conversations_update policy already covers any column.
alter table public.whatsapp_conversations
  add column archived_at timestamptz;

create index whatsapp_conversations_archived_at_idx on public.whatsapp_conversations(archived_at) where archived_at is not null;
