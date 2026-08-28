ALTER TABLE `cash_flow_forecasts` ADD `account_id` integer REFERENCES accounts(id);--> statement-breakpoint
ALTER TABLE `cash_flow_forecasts` ADD `category_id` integer REFERENCES categories(id);--> statement-breakpoint
ALTER TABLE `transactions` ADD `pending` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `forecast_id` integer REFERENCES cash_flow_forecasts(id);--> statement-breakpoint
CREATE INDEX `txn_pending_idx` ON `transactions` (`pending`);