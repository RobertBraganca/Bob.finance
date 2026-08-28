CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`institution` text NOT NULL,
	`kind` text DEFAULT 'checking' NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`opening_balance_cents` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `asset_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`kind` text DEFAULT 'buy' NOT NULL,
	`traded_on` text NOT NULL,
	`quantity` real DEFAULT 0 NOT NULL,
	`unit_price_cents` integer DEFAULT 0 NOT NULL,
	`fees_cents` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `asset_trades_asset_idx` ON `asset_trades` (`asset_id`,`traded_on`);--> statement-breakpoint
CREATE TABLE `asset_valuations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`as_of` text NOT NULL,
	`unit_price_cents` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_valuations_uq` ON `asset_valuations` (`asset_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`ticker` text,
	`asset_class` text DEFAULT 'stocks' NOT NULL,
	`currency` text DEFAULT 'BRL' NOT NULL,
	`account_id` integer,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_name_uq` ON `assets` (`name`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_id` integer,
	`name` text NOT NULL,
	`kind` text DEFAULT 'expense' NOT NULL,
	`color` text DEFAULT '#2a78d6' NOT NULL,
	`icon` text DEFAULT 'tag' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `categories_parent_name_uq` ON `categories` (`parent_id`,`name`);--> statement-breakpoint
CREATE TABLE `category_caps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`period` text NOT NULL,
	`category_id` integer NOT NULL,
	`cap_cents` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_caps_uq` ON `category_caps` (`period`,`category_id`);--> statement-breakpoint
CREATE TABLE `category_memory` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`signature` text NOT NULL,
	`category_id` integer NOT NULL,
	`hits` integer DEFAULT 1 NOT NULL,
	`promoted_rule_id` integer,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`promoted_rule_id`) REFERENCES `category_rules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_memory_uq` ON `category_memory` (`signature`,`category_id`);--> statement-breakpoint
CREATE TABLE `category_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer NOT NULL,
	`field` text DEFAULT 'description' NOT NULL,
	`match_type` text DEFAULT 'contains' NOT NULL,
	`pattern` text NOT NULL,
	`direction` text DEFAULT 'any' NOT NULL,
	`amount_min_cents` integer,
	`amount_max_cents` integer,
	`account_id` integer,
	`priority` integer DEFAULT 100 NOT NULL,
	`origin` text DEFAULT 'user' NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `category_rules_priority_idx` ON `category_rules` (`priority`);--> statement-breakpoint
CREATE UNIQUE INDEX `category_rules_uq` ON `category_rules` (`field`,`match_type`,`pattern`,`direction`);--> statement-breakpoint
CREATE TABLE `debt_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`debt_id` integer NOT NULL,
	`as_of` text NOT NULL,
	`balance_cents` integer NOT NULL,
	FOREIGN KEY (`debt_id`) REFERENCES `debts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `debt_snapshot_uq` ON `debt_snapshots` (`debt_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `debts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'credit_card' NOT NULL,
	`institution` text,
	`principal_cents` integer DEFAULT 0 NOT NULL,
	`apr_bps` integer DEFAULT 0 NOT NULL,
	`minimum_payment_cents` integer DEFAULT 0 NOT NULL,
	`scheduled_payment_cents` integer DEFAULT 0 NOT NULL,
	`due_day` integer DEFAULT 10 NOT NULL,
	`account_id` integer,
	`opened_on` text,
	`closed_on` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer,
	`account_id` integer NOT NULL,
	`filename` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`parsed_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`committed_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `parser_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `investment_goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`target_value_cents` integer DEFAULT 0 NOT NULL,
	`target_date` text,
	`monthly_contribution_cents` integer DEFAULT 0 NOT NULL,
	`expected_return_bps` integer DEFAULT 800 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `monthly_goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`period` text NOT NULL,
	`income_target_cents` integer,
	`spend_cap_cents` integer,
	`savings_rate_target_bps` integer,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `monthly_goals_period_uq` ON `monthly_goals` (`period`);--> statement-breakpoint
CREATE TABLE `parser_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`institution` text NOT NULL,
	`delimiter` text DEFAULT ';' NOT NULL,
	`encoding` text DEFAULT 'utf-8' NOT NULL,
	`date_format` text DEFAULT 'dd/MM/yyyy' NOT NULL,
	`decimal_separator` text DEFAULT ',' NOT NULL,
	`thousands_separator` text DEFAULT '.' NOT NULL,
	`sign_convention` text DEFAULT 'signed' NOT NULL,
	`has_header` integer DEFAULT true NOT NULL,
	`skip_rows` integer DEFAULT 0 NOT NULL,
	`column_map` text NOT NULL,
	`header_signature` text NOT NULL,
	`ignore_patterns` text NOT NULL,
	`default_account_id` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	FOREIGN KEY (`default_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parser_profiles_name_uq` ON `parser_profiles` (`name`);--> statement-breakpoint
CREATE TABLE `staged_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`row_index` integer NOT NULL,
	`posted_on` text,
	`description` text DEFAULT '' NOT NULL,
	`description_norm` text DEFAULT '' NOT NULL,
	`amount_cents` integer,
	`raw_category` text,
	`dedupe_hash` text,
	`duplicate_of` text DEFAULT 'none' NOT NULL,
	`duplicate_txn_id` integer,
	`suggested_category_id` integer,
	`suggestion_source` text DEFAULT 'none' NOT NULL,
	`suggestion_detail` text,
	`category_id` integer,
	`include` integer DEFAULT true NOT NULL,
	`parse_error` text,
	`raw_line` text,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`suggested_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `staged_batch_idx` ON `staged_transactions` (`batch_id`);--> statement-breakpoint
CREATE TABLE `target_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`goal_id` integer,
	`asset_class` text NOT NULL,
	`target_bps` integer NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `investment_goals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `target_alloc_uq` ON `target_allocations` (`goal_id`,`asset_class`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`posted_on` text NOT NULL,
	`description` text NOT NULL,
	`description_norm` text DEFAULT '' NOT NULL,
	`amount_cents` integer NOT NULL,
	`direction` text NOT NULL,
	`category_id` integer,
	`raw_category` text,
	`source` text DEFAULT 'csv' NOT NULL,
	`categorized_by` text DEFAULT 'none' NOT NULL,
	`rule_id` integer,
	`import_batch_id` integer,
	`dedupe_hash` text NOT NULL,
	`duplicate_accepted` integer DEFAULT false NOT NULL,
	`notes` text,
	`debt_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`rule_id`) REFERENCES `category_rules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `txn_posted_idx` ON `transactions` (`posted_on`);--> statement-breakpoint
CREATE INDEX `txn_account_posted_idx` ON `transactions` (`account_id`,`posted_on`);--> statement-breakpoint
CREATE INDEX `txn_category_idx` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `txn_dedupe_idx` ON `transactions` (`account_id`,`dedupe_hash`);