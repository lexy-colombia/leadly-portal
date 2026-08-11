-- Obsolete since the "mensajes fantasma" fix (2026-08-05): whatsapp_messages
-- rows are now only ever inserted after a confirmed successful send (see
-- whatsapp-ai-respond/whatsapp-send-human/send-appointment-reminders), so
-- nothing has written to error_message since, and 0 existing rows have a
-- value in it. Drops the column and its dead UI branch in MessageBubble.tsx
-- (removed in the same commit as this migration).
alter table public.whatsapp_messages drop column error_message;
