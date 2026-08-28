CREATE TABLE `financial_health_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`weight_liquidity` integer DEFAULT 20 NOT NULL,
	`weight_debt` integer DEFAULT 20 NOT NULL,
	`weight_spending` integer DEFAULT 20 NOT NULL,
	`weight_reserve` integer DEFAULT 20 NOT NULL,
	`weight_allocation` integer DEFAULT 20 NOT NULL,
	`cost_lookback_months` integer DEFAULT 3 NOT NULL,
	`risk_card_share_bps` integer DEFAULT 3500 NOT NULL,
	`risk_reserve_coverage_bps` integer DEFAULT 10000 NOT NULL,
	`risk_allocation_drift_bps` integer DEFAULT 1000 NOT NULL,
	`risk_spending_cap_bps` integer DEFAULT 10000 NOT NULL,
	`risk_debt_to_income_bps` integer DEFAULT 3000 NOT NULL
);
