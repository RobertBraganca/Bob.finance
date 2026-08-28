PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_transactions` (
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
	`pending` integer DEFAULT false NOT NULL,
	`forecast_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`rule_id`) REFERENCES `category_rules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`debt_id`) REFERENCES `debts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`forecast_id`) REFERENCES `cash_flow_forecasts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "account_id", "posted_on", "description", "description_norm", "amount_cents", "direction", "category_id", "raw_category", "source", "categorized_by", "rule_id", "import_batch_id", "dedupe_hash", "duplicate_accepted", "notes", "debt_id", "pending", "forecast_id", "created_at", "updated_at") SELECT "id", "account_id", "posted_on", "description", "description_norm", "amount_cents", "direction", "category_id", "raw_category", "source", "categorized_by", "rule_id", "import_batch_id", "dedupe_hash", "duplicate_accepted", "notes", "debt_id", "pending", "forecast_id", "created_at", "updated_at" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `txn_posted_idx` ON `transactions` (`posted_on`);--> statement-breakpoint
CREATE INDEX `txn_account_posted_idx` ON `transactions` (`account_id`,`posted_on`);--> statement-breakpoint
CREATE INDEX `txn_category_idx` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `txn_dedupe_idx` ON `transactions` (`account_id`,`dedupe_hash`);--> statement-breakpoint
CREATE INDEX `txn_pending_idx` ON `transactions` (`pending`);