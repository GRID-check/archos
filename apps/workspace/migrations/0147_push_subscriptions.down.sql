-- Reverse 0147. ORDER: roll the frontend back first; the newer build registers
-- devices through this table and its `inbox_push` jobs read it.
--
-- Lossy: every person's devices are forgotten and notifications stop until they
-- turn them on again. The inbox itself is untouched.
DROP TABLE IF EXISTS "push_subscriptions";
