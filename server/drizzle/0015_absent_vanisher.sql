CREATE TABLE `financial_engine_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pj_account_id` integer,
	`pf_account_id` integer,
	`pro_labore_cents` integer,
	`tax_rate_bps` integer DEFAULT 0 NOT NULL,
	`reserve_planned_cents` integer DEFAULT 0 NOT NULL,
	`margin_cents` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`pj_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`pf_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
