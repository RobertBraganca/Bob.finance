CREATE TABLE `reconciliation_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pending_id` integer NOT NULL,
	`match_id` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_dismissals_uq` ON `reconciliation_dismissals` (`pending_id`,`match_id`);