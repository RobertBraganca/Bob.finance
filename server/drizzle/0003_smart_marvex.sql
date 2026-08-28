CREATE TABLE `credit_card_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`as_of` text NOT NULL,
	`available_limit_cents` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_card_snapshot_uq` ON `credit_card_snapshots` (`card_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `credit_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`institution` text,
	`account_id` integer,
	`credit_limit_cents` integer DEFAULT 0 NOT NULL,
	`closing_day` integer DEFAULT 1 NOT NULL,
	`due_day` integer DEFAULT 10 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
