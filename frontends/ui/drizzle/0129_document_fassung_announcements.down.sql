-- Reverse 0129. ORDER: roll the frontend back first; the newer build writes and
-- reads `document_fassung_announcements` on every announcement.
--
-- Lossy in the noisy direction: the older build deduplicates by the inbox rows
-- recipients still hold, so a re-read can announce a Fassung again to someone
-- assigned since or whose row aged out. Nothing is exposed that was not before.
DROP TABLE IF EXISTS "document_fassung_announcements";
