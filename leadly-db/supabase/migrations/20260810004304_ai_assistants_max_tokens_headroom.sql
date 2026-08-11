-- Companion to the whatsapp-ai-respond code fix (thinkingConfig.thinkingBudget
-- = 0 for Gemini) from the same incident: 1024 was too tight even without
-- the thinking-token issue for an elaborate reply ("plan de estudios, valor,
-- horarios y todo"). Extra headroom so a verbose customer ask doesn't run
-- into the cap again.
alter table ai_assistants alter column max_tokens set default 2048;
update ai_assistants set max_tokens = 2048 where max_tokens = 1024;
