-- SQLite refuses a non-constant default (strftime(...)) on ADD COLUMN, even
-- though the identical expression is fine at CREATE TABLE time — hand-edited
-- from what drizzle-kit generated to work around that: add nullable, then
-- backfill every existing row from created_at (never edited yet, so the two
-- are the same value), instead of a single ALTER with a function default.
ALTER TABLE `project_quotes` ADD `updated_at` text;
--> statement-breakpoint
UPDATE `project_quotes` SET `updated_at` = `created_at` WHERE `updated_at` IS NULL;
