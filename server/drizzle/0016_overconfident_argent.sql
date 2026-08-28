CREATE TABLE `pricing_multiplier_options` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dimension` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`multiplier_bps` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pricing_multiplier_dimension_idx` ON `pricing_multiplier_options` (`dimension`);--> statement-breakpoint
CREATE TABLE `pricing_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`available_hours_per_month` integer DEFAULT 176 NOT NULL,
	`billable_percentage_bps` integer DEFAULT 6000 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `project_quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_label` text NOT NULL,
	`estimated_hours` real NOT NULL,
	`direct_costs` text DEFAULT '[]' NOT NULL,
	`complexity_option_id` integer,
	`urgency_option_id` integer,
	`client_size_option_id` integer,
	`usage_rights_option_id` integer,
	`extra_margin_bps` integer DEFAULT 0 NOT NULL,
	`hourly_base_cents` integer NOT NULL,
	`minimum_price_cents` integer NOT NULL,
	`recommended_price_cents` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	FOREIGN KEY (`complexity_option_id`) REFERENCES `pricing_multiplier_options`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`urgency_option_id`) REFERENCES `pricing_multiplier_options`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`client_size_option_id`) REFERENCES `pricing_multiplier_options`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`usage_rights_option_id`) REFERENCES `pricing_multiplier_options`(`id`) ON UPDATE no action ON DELETE set null
);
