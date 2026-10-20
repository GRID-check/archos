-- Reverse 0154. ORDER: roll the frontend and the agent back first; the newer
-- builds resolve every organization's key from this table and refuse to fall
-- back to the shared key.
--
-- Lossy: the rows that point at each organization's OpenRouter key are gone, and
-- the keys themselves stay live at OpenRouter until they are deleted there.
DROP TABLE IF EXISTS "org_openrouter_keys";
