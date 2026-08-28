CREATE TABLE `cash_flow_forecasts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`description` text NOT NULL,
	`kind` text DEFAULT 'recurring' NOT NULL,
	`amount_cents` integer NOT NULL,
	`start_period` text NOT NULL,
	`installment_count` integer,
	`installments_realized` integer DEFAULT 0 NOT NULL,
	`end_period` text,
	`notes` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `emergency_reserve_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`multiple` integer DEFAULT 6 NOT NULL,
	`lookback_months` integer DEFAULT 3 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `assets` ADD `counts_toward_reserve` integer DEFAULT false NOT NULL;