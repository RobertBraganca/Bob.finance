CREATE TABLE `skipped_occurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`forecast_id` integer,
	`debt_id` integer,
	`period` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	FOREIGN KEY (`forecast_id`) REFERENCES `cash_flow_forecasts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`debt_id`) REFERENCES `debts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skipped_occurrences_uq` ON `skipped_occurrences` (`forecast_id`,`debt_id`,`period`);