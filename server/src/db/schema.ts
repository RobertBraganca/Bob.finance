import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const now = sql`(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`

/* ------------------------------------------------------------------ *
 * Accounts — multi-account from day one, even though v1 is one user.
 * ------------------------------------------------------------------ */
export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  institution: text('institution').notNull(),
  /** checking | savings | credit_card | investment | loan | cash */
  kind: text('kind').notNull().default('checking'),
  currency: text('currency').notNull().default('BRL'),
  openingBalanceCents: integer('opening_balance_cents').notNull().default(0),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(now),
})

/* ------------------------------------------------------------------ *
 * Parser profiles — a bank's CSV dialect expressed as DATA, so adding
 * a bank is a row, never a code change in the import pipeline.
 * ------------------------------------------------------------------ */
export const parserProfiles = sqliteTable(
  'parser_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    institution: text('institution').notNull(),
    /** "," | ";" | "tab" | "auto" */
    delimiter: text('delimiter').notNull().default(';'),
    encoding: text('encoding').notNull().default('utf-8'),
    /** dd/MM/yyyy | yyyy-MM-dd | dd-MM-yyyy | dd/MM/yy */
    dateFormat: text('date_format').notNull().default('dd/MM/yyyy'),
    decimalSeparator: text('decimal_separator').notNull().default(','),
    thousandsSeparator: text('thousands_separator').notNull().default('.'),
    /**
     * signed          one amount column, minus sign means money out
     * signed_inverted one amount column, minus sign means money in (card bills)
     * debit_credit    separate debit and credit columns
     * type_flag       absolute amount plus a type column (D/C, DEBITO/CREDITO)
     */
    signConvention: text('sign_convention').notNull().default('signed'),
    hasHeader: integer('has_header', { mode: 'boolean' }).notNull().default(true),
    skipRows: integer('skip_rows').notNull().default(0),
    /** JSON map of logical field to CSV header name (or numeric index) */
    columnMap: text('column_map', { mode: 'json' }).notNull(),
    /** JSON string[] — header tokens used to auto-detect this profile */
    headerSignature: text('header_signature', { mode: 'json' }).notNull(),
    /** JSON string[] — rows matching these are dropped (totals, balance lines) */
    ignorePatterns: text('ignore_patterns', { mode: 'json' }).notNull(),
    defaultAccountId: integer('default_account_id').references(() => accounts.id),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('parser_profiles_name_uq').on(t.name)],
)

/* ------------------------------------------------------------------ *
 * Category tree — parent row plus children. One level of nesting is
 * the product contract; the schema allows deeper without migration.
 * ------------------------------------------------------------------ */
export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    parentId: integer('parent_id'),
    name: text('name').notNull(),
    /** income | expense | transfer | investment */
    kind: text('kind').notNull().default('expense'),
    // NOTE: kept at the original default on purpose. Changing a column
    // default on a table other tables reference by foreign key forces
    // drizzle-kit's SQLite dialect to rebuild the table (create/copy/drop/
    // rename), and that DROP TABLE step enforces FK constraints even
    // under `PRAGMA foreign_keys=OFF` — SQLite no-ops that pragma inside a
    // transaction, so the migration fails against any real, referenced
    // data. The application layer (categories.ts createCategory) already
    // defaults new categories to the brand blue; the column default below
    // is a fallback for direct inserts only and isn't worth the risk.
    color: text('color').notNull().default('#2a78d6'),
    icon: text('icon').notNull().default('tag'),
    sortOrder: integer('sort_order').notNull().default(0),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('categories_parent_idx').on(t.parentId),
    uniqueIndex('categories_parent_name_uq').on(t.parentId, t.name),
  ],
)

/* ------------------------------------------------------------------ *
 * Rules — deterministic, user-editable, evaluated by priority.
 * ------------------------------------------------------------------ */
export const categoryRules = sqliteTable(
  'category_rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    /** description | raw_category */
    field: text('field').notNull().default('description'),
    /** contains | starts_with | equals | regex */
    matchType: text('match_type').notNull().default('contains'),
    pattern: text('pattern').notNull(),
    /** any | in | out */
    direction: text('direction').notNull().default('any'),
    amountMinCents: integer('amount_min_cents'),
    amountMaxCents: integer('amount_max_cents'),
    accountId: integer('account_id').references(() => accounts.id),
    priority: integer('priority').notNull().default(100),
    /** user | learned */
    origin: text('origin').notNull().default('user'),
    hitCount: integer('hit_count').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('category_rules_priority_idx').on(t.priority),
    uniqueIndex('category_rules_uq').on(t.field, t.matchType, t.pattern, t.direction),
  ],
)

/**
 * Learned memory — every manual correction bumps a counter for the
 * normalized merchant signature. The suggestion layer reads this by
 * frequency; it becomes a real rule only when promoted (manually, or
 * automatically once it crosses the confirmation threshold).
 */
export const categoryMemory = sqliteTable(
  'category_memory',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    signature: text('signature').notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    hits: integer('hits').notNull().default(1),
    promotedRuleId: integer('promoted_rule_id').references(() => categoryRules.id, {
      onDelete: 'set null',
    }),
    lastSeenAt: text('last_seen_at').notNull().default(now),
  },
  (t) => [uniqueIndex('category_memory_uq').on(t.signature, t.categoryId)],
)

/* ------------------------------------------------------------------ *
 * Import staging — nothing reaches `transactions` before review.
 * ------------------------------------------------------------------ */
export const importBatches = sqliteTable('import_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').references(() => parserProfiles.id),
  accountId: integer('account_id')
    .notNull()
    .references(() => accounts.id),
  filename: text('filename').notNull(),
  rowCount: integer('row_count').notNull().default(0),
  parsedCount: integer('parsed_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  committedCount: integer('committed_count').notNull().default(0),
  /** staged | committed | discarded */
  status: text('status').notNull().default('staged'),
  createdAt: text('created_at').notNull().default(now),
})

export const stagedTransactions = sqliteTable(
  'staged_transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    batchId: integer('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    rowIndex: integer('row_index').notNull(),
    postedOn: text('posted_on'),
    description: text('description').notNull().default(''),
    descriptionNorm: text('description_norm').notNull().default(''),
    amountCents: integer('amount_cents'),
    rawCategory: text('raw_category'),
    dedupeHash: text('dedupe_hash'),
    /** none | in_batch | in_ledger */
    duplicateOf: text('duplicate_of').notNull().default('none'),
    duplicateTxnId: integer('duplicate_txn_id'),
    suggestedCategoryId: integer('suggested_category_id').references(() => categories.id),
    /** rule | memory | raw_category | none */
    suggestionSource: text('suggestion_source').notNull().default('none'),
    suggestionDetail: text('suggestion_detail'),
    /** the reviewer's choice; falls back to the suggestion on commit */
    categoryId: integer('category_id').references(() => categories.id),
    include: integer('include', { mode: 'boolean' }).notNull().default(true),
    parseError: text('parse_error'),
    rawLine: text('raw_line'),
  },
  (t) => [index('staged_batch_idx').on(t.batchId)],
)

/* ------------------------------------------------------------------ *
 * transactions — THE single source of truth. Every dashboard is an
 * aggregation over this table; there are no derived report tables.
 * ------------------------------------------------------------------ */
export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    /** ISO date YYYY-MM-DD — sorts chronologically as text */
    postedOn: text('posted_on').notNull(),
    description: text('description').notNull(),
    descriptionNorm: text('description_norm').notNull().default(''),
    /** signed integer cents: negative = money out, positive = money in */
    amountCents: integer('amount_cents').notNull(),
    /** derived from the sign, stored so aggregations skip CASE everywhere */
    direction: text('direction').notNull(),
    categoryId: integer('category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    rawCategory: text('raw_category'),
    /** csv | manual | daily | adjustment */
    source: text('source').notNull().default('csv'),
    /** rule | memory | manual | raw_category | none */
    categorizedBy: text('categorized_by').notNull().default('none'),
    ruleId: integer('rule_id').references(() => categoryRules.id, { onDelete: 'set null' }),
    importBatchId: integer('import_batch_id').references(() => importBatches.id, {
      onDelete: 'set null',
    }),
    dedupeHash: text('dedupe_hash').notNull(),
    /** set when the reviewer knowingly kept a flagged duplicate */
    duplicateAccepted: integer('duplicate_accepted', { mode: 'boolean' })
      .notNull()
      .default(false),
    notes: text('notes'),
    /**
     * A confirmed future receipt/expense the bank hasn't posted yet — a
     * freelancer's next invoice, an already-agreed installment. Lives in
     * this same table (unified with real lançamentos) but every totals
     * query excludes it by default, so it can never inflate a closed
     * period's real Entradas/Saídas. Becomes a normal row (pending=false)
     * once reconciled against the real posted transaction, or stays
     * pending until the statement actually arrives.
     */
    pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
    /** the recurring/installment template that materialized this row, if any */
    forecastId: integer('forecast_id').references(() => cashFlowForecasts.id, { onDelete: 'cascade' }),
    /** the debt whose remaining parcela this row materializes, if any */
    debtId: integer('debt_id').references(() => debts.id, { onDelete: 'cascade' }),
    /**
     * The YYYY-MM occurrence a materialized row fills, fixed at creation
     * time — independent of `postedOn`, which the user can freely edit
     * (e.g. to correct the real payment date) without that edit being
     * mistaken for "this occurrence never happened", which used to
     * re-materialize a duplicate for the vacated month.
     */
    occurrencePeriod: text('occurrence_period'),
    /**
     * Set the first time the user edits postedOn/description/amountCents
     * of a pending row tied to a forecast or debt template (see
     * `decisions/0017`). Once true, syncMaterializedRows skips the row
     * entirely on the next template edit — the user's correction is
     * authoritative over that specific occurrence from then on.
     */
    manuallyEdited: integer('manually_edited', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    index('txn_posted_idx').on(t.postedOn),
    index('txn_account_posted_idx').on(t.accountId, t.postedOn),
    index('txn_category_idx').on(t.categoryId),
    index('txn_dedupe_idx').on(t.accountId, t.dedupeHash),
    index('txn_pending_idx').on(t.pending),
  ],
)

/* ------------------------------------------------------------------ *
 * Debt
 * ------------------------------------------------------------------ */
export const debts = sqliteTable('debts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  /** credit_card | personal_loan | financing | overdraft | student | other */
  kind: text('kind').notNull().default('credit_card'),
  institution: text('institution'),
  principalCents: integer('principal_cents').notNull().default(0),
  /** annual nominal rate in basis points: 1200 = 12.00% a.a. */
  aprBps: integer('apr_bps').notNull().default(0),
  minimumPaymentCents: integer('minimum_payment_cents').notNull().default(0),
  scheduledPaymentCents: integer('scheduled_payment_cents').notNull().default(0),
  dueDay: integer('due_day').notNull().default(10),
  /** total parcelas in the contract — null for revolving debt (cartão, cheque especial) that has none */
  installmentCount: integer('installment_count'),
  /**
   * Optional last period a revolving debt (installmentCount = null) still
   * materializes a pendency for — mirrors cashFlowForecasts.endPeriod.
   * Set when the user deletes a pendency with scope "esta e as futuras"
   * (decisions/0020): a revolving debt has no natural end, so bounding
   * future materialization needs an explicit stop the same way a recurring
   * forecast does.
   */
  endPeriod: text('end_period'),
  accountId: integer('account_id').references(() => accounts.id),
  openedOn: text('opened_on'),
  closedOn: text('closed_on'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(now),
})

/** Balance history, so the debt trend is measured rather than guessed. */
export const debtSnapshots = sqliteTable(
  'debt_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    debtId: integer('debt_id')
      .notNull()
      .references(() => debts.id, { onDelete: 'cascade' }),
    asOf: text('as_of').notNull(),
    balanceCents: integer('balance_cents').notNull(),
  },
  (t) => [uniqueIndex('debt_snapshot_uq').on(t.debtId, t.asOf)],
)

/**
 * The payment ledger — same idea as `asset_trades` for investments: a log
 * of real events (parcela paga, novo uso/saque) that the UI can show and
 * count, entirely separate from `debt_snapshots` (the measured balance).
 * A payment does NOT itself move `balanceCents` — interest vs. principal
 * split isn't known from the amount alone — so the balance still comes
 * from a snapshot; this table only answers "how many parcelas, when,
 * how much", which the balance alone cannot.
 */
export const debtPayments = sqliteTable(
  'debt_payments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    debtId: integer('debt_id')
      .notNull()
      .references(() => debts.id, { onDelete: 'cascade' }),
    /** payment | charge — a payment counts toward parcelas pagas; a charge is new use (cartão, saque) */
    kind: text('kind').notNull().default('payment'),
    paidOn: text('paid_on').notNull(),
    amountCents: integer('amount_cents').notNull(),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('debt_payments_debt_idx').on(t.debtId, t.paidOn)],
)

/* ------------------------------------------------------------------ *
 * Credit cards — the foundation for crossing credit spend against the
 * limit/cycle, not the spend itself (that still lives in `transactions`,
 * tagged by account or category). A card is its own entity, distinct
 * from the checking `account` that pays its bill, because "Cartão" and
 * "Conta" are two different columns the user asked for by name.
 * ------------------------------------------------------------------ */
export const creditCards = sqliteTable('credit_cards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  institution: text('institution'),
  /** the checking account whose statement pays this card's bill */
  accountId: integer('account_id').references(() => accounts.id),
  creditLimitCents: integer('credit_limit_cents').notNull().default(0),
  /** day of month the invoice closes */
  closingDay: integer('closing_day').notNull().default(1),
  /** day of month the invoice is due */
  dueDay: integer('due_day').notNull().default(10),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(now),
})

/**
 * Available-limit history, same idea as `debt_snapshots` — a measured
 * point in time rather than something derived, since per-transaction
 * credit-card spend isn't tracked separately from the checking ledger
 * yet. This IS the "base para cruzamento" the predictive-analysis goal
 * needs: a trend of available limit to read spend velocity from, before
 * any real transaction-level crossing exists.
 */
export const creditCardSnapshots = sqliteTable(
  'credit_card_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    cardId: integer('card_id')
      .notNull()
      .references(() => creditCards.id, { onDelete: 'cascade' }),
    asOf: text('as_of').notNull(),
    availableLimitCents: integer('available_limit_cents').notNull(),
  },
  (t) => [uniqueIndex('credit_card_snapshot_uq').on(t.cardId, t.asOf)],
)

/* ------------------------------------------------------------------ *
 * Monthly goals
 * ------------------------------------------------------------------ */
export const monthlyGoals = sqliteTable(
  'monthly_goals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** YYYY-MM */
    period: text('period').notNull(),
    incomeTargetCents: integer('income_target_cents'),
    spendCapCents: integer('spend_cap_cents'),
    /** basis points: 2000 = 20% */
    savingsRateTargetBps: integer('savings_rate_target_bps'),
    note: text('note'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('monthly_goals_period_uq').on(t.period)],
)

export const categoryCaps = sqliteTable(
  'category_caps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    period: text('period').notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    capCents: integer('cap_cents').notNull(),
  },
  (t) => [uniqueIndex('category_caps_uq').on(t.period, t.categoryId)],
)

/* ------------------------------------------------------------------ *
 * Investments
 * ------------------------------------------------------------------ */
export const assets = sqliteTable(
  'assets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    ticker: text('ticker'),
    /** stocks | fii | fixed_income | treasury | crypto | funds | etf_intl | cash | pension | other — see ASSET_CLASSES in services/investments.ts, the real source of truth */
    assetClass: text('asset_class').notNull().default('stocks'),
    /** BRAPI's summaryProfile.sector (e.g. "Energia", "Bancos") — populated on quote refresh, null until then */
    sector: text('sector'),
    currency: text('currency').notNull().default('BRL'),
    accountId: integer('account_id').references(() => accounts.id),
    /** counts toward the emergency-reserve progress (e.g. a CDB/Tesouro Selic held as reserve) */
    countsTowardReserve: integer('counts_toward_reserve', { mode: 'boolean' }).notNull().default(false),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('assets_name_uq').on(t.name)],
)

/**
 * Singleton settings row (id is always 1) — the reserve TARGET is a
 * multiple of monthly cost of living, computed fresh from real expense
 * data rather than stored, so it tracks spending as it changes. This
 * table only holds the multiple and how many months to average.
 */
export const emergencyReserveSettings = sqliteTable('emergency_reserve_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** months of living cost to hold: 6, 12, or 24 */
  multiple: integer('multiple').notNull().default(6),
  lookbackMonths: integer('lookback_months').notNull().default(3),
  /**
   * Overrides the computed average when set — the real average mixes
   * every account's expenses (PF personal AND PJ business), which can
   * overstate personal cost of living. Null means "use the computed
   * average"; the user can always clear it to go back to automatic.
   */
  manualLivingCostCents: integer('manual_living_cost_cents'),
})

/**
 * A recurring retainer or an already-agreed installment deal — the
 * template that materializes real rows into `transactions` (pending =
 * true) for every future occurrence, rather than a separate preview.
 * Unified with the real ledger by the user's own choice: it shows up
 * in Lançamentos and in the pending widgets, and totals queries just
 * filter pending out, so a forecast never distorts a closed period's
 * real Entradas/Saídas until the bank statement actually confirms it.
 */
export const cashFlowForecasts = sqliteTable('cash_flow_forecasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  description: text('description').notNull(),
  /** recurring | installment | single */
  kind: text('kind').notNull().default('recurring'),
  amountCents: integer('amount_cents').notNull(),
  /** the account this is expected to post to once real — needed to reconcile against the real CSV row */
  accountId: integer('account_id').references(() => accounts.id),
  categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
  /** YYYY-MM of the first occurrence (recurring) or installment #1 (installment) */
  startPeriod: text('start_period').notNull(),
  /** day of month the money is expected to land — defaults to 1 for rows created before this existed */
  dueDay: integer('due_day').notNull().default(1),
  /** total parcelas — null for recurring, which has no end */
  installmentCount: integer('installment_count'),
  /** how many parcelas are already confirmed/received, e.g. 1 of 3 */
  installmentsRealized: integer('installments_realized').notNull().default(0),
  /** optional last period for a recurring entry that has a known end */
  endPeriod: text('end_period'),
  notes: text('notes'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(now),
})

/** A suggested (pending, real) pair the user said is NOT a match — kept
 * out of `reconciliationCandidates` from then on, since the candidate
 * list is recomputed fresh from amount+date proximity every load and
 * would otherwise keep re-suggesting the same false positive. */
export const reconciliationDismissals = sqliteTable(
  'reconciliation_dismissals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    pendingId: integer('pending_id').notNull(),
    matchId: integer('match_id').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('reconciliation_dismissals_uq').on(t.pendingId, t.matchId)],
)

/**
 * A recurring/installment occurrence the user explicitly deleted from a
 * "pendentes" widget — not "not yet materialized" but "never happening".
 * Without this, materialize()/materializeDebtInstallments() only know a
 * period as covered by finding a still-existing row for it, so deleting
 * that row made the very next pending-widget load recreate it, and a
 * delete looked like it silently failed.
 */
export const skippedOccurrences = sqliteTable(
  'skipped_occurrences',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    forecastId: integer('forecast_id').references(() => cashFlowForecasts.id, { onDelete: 'cascade' }),
    debtId: integer('debt_id').references(() => debts.id, { onDelete: 'cascade' }),
    /** YYYY-MM */
    period: text('period').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('skipped_occurrences_uq').on(t.forecastId, t.debtId, t.period)],
)

/** Contributions and withdrawals — the "contributed capital" line. */
export const assetTrades = sqliteTable(
  'asset_trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    /** buy | sell | dividend */
    kind: text('kind').notNull().default('buy'),
    tradedOn: text('traded_on').notNull(),
    quantity: real('quantity').notNull().default(0),
    unitPriceCents: integer('unit_price_cents').notNull().default(0),
    feesCents: integer('fees_cents').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('asset_trades_asset_idx').on(t.assetId, t.tradedOn)],
)

/** Marks to market — the "portfolio value" line. */
export const assetValuations = sqliteTable(
  'asset_valuations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    asOf: text('as_of').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
  },
  (t) => [uniqueIndex('asset_valuations_uq').on(t.assetId, t.asOf)],
)

/**
 * Monthly return of the portfolio's benchmarks — CDI/IPCA from the Banco
 * Central's SGS API (full history, no range limit) and B3 index proxies
 * (IBOV/IFIX/SMLL/IDIV/IVVB11) approximated from the ETF that tracks each
 * one via BRAPI, whose free plan only exposes a rolling ~3-month window.
 * Storing every fetch's result means the ETF-based codes build up full
 * history over time (one point at a time) instead of re-fetching a
 * window that will never reach back to when the portfolio started.
 */
export const benchmarkReturns = sqliteTable(
  'benchmark_returns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** CDI | IPCA | IBOV | IFIX | SMLL | IDIV | IVVB11 */
    code: text('code').notNull(),
    period: text('period').notNull(),
    returnBps: integer('return_bps').notNull(),
    /** bcb | brapi_etf */
    source: text('source').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('benchmark_returns_uq').on(t.code, t.period)],
)

export const investmentGoals = sqliteTable('investment_goals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  targetValueCents: integer('target_value_cents').notNull().default(0),
  targetDate: text('target_date'),
  monthlyContributionCents: integer('monthly_contribution_cents').notNull().default(0),
  /** expected annual return, basis points */
  expectedReturnBps: integer('expected_return_bps').notNull().default(800),
  /**
   * retirement | buy_property | financial_independence | children_education
   * | travel — purely an organizing label the user picks, shown next to
   * this goal's own alocação-alvo (targetAllocations, already scoped by
   * goalId). Never read by suggestContribution or any other calculation —
   * see `decisions/0010`: the app evidences, it doesn't pick a class
   * because of a stated purpose. Null when the user leaves it unset.
   */
  purpose: text('purpose'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(now),
})

export const targetAllocations = sqliteTable(
  'target_allocations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    goalId: integer('goal_id').references(() => investmentGoals.id, { onDelete: 'cascade' }),
    assetClass: text('asset_class').notNull(),
    /** basis points of the portfolio: 3000 = 30% */
    targetBps: integer('target_bps').notNull(),
  },
  (t) => [uniqueIndex('target_alloc_uq').on(t.goalId, t.assetClass)],
)

/* ------------------------------------------------------------------ *
 * Resistance scoring ("Diagrama do Cerrado") — a yes/no questionnaire
 * per asset class. Each question is worth +1 checked / -1 unchecked;
 * the sum drives how much of a class's target allocation an asset is
 * allowed to claim. Deliberately a question BANK plus per-asset
 * ANSWERS, not a single stored note: the note is always derived fresh
 * from live answers (services/criteria.ts), matching this app's rule
 * that nothing gets cached that could drift from its source.
 * ------------------------------------------------------------------ */
export const criteria = sqliteTable(
  'criteria',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** stocks | fii | fixed_income | treasury | crypto | funds | etf_intl | cash | pension | other — see ASSET_CLASSES in services/investments.ts, the real source of truth */
    assetClass: text('asset_class').notNull(),
    label: text('label').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('criteria_class_idx').on(t.assetClass)],
)

export const assetCriteriaAnswers = sqliteTable(
  'asset_criteria_answers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    criteriaId: integer('criteria_id')
      .notNull()
      .references(() => criteria.id, { onDelete: 'cascade' }),
    checked: integer('checked', { mode: 'boolean' }).notNull(),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('asset_criteria_uq').on(t.assetId, t.criteriaId)],
)

/* ------------------------------------------------------------------ *
 * Financial-health parameters — the ONLY thing the intelligence layer
 * stores. Every number it reports (Health Score, Runway, Radar de
 * risco) is derived fresh from `transactions` and the existing debt/
 * card/goal/investment tables; what lives here is exclusively the
 * user's own choice of weights and thresholds, so no calculation
 * constant is buried in code where the user cannot see or change it
 * (see decisions/0010). Singleton row, id always 1 — same shape as
 * `emergency_reserve_settings`.
 * ------------------------------------------------------------------ */
export const financialHealthSettings = sqliteTable('financial_health_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  /* Health Score composition — relative weights, normalized at read time,
   * so they do not have to add up to 100 for the score to make sense. */
  weightLiquidity: integer('weight_liquidity').notNull().default(20),
  weightDebt: integer('weight_debt').notNull().default(20),
  weightSpending: integer('weight_spending').notNull().default(20),
  weightReserve: integer('weight_reserve').notNull().default(20),
  weightAllocation: integer('weight_allocation').notNull().default(20),

  /** months of history averaged into "custo mensal médio" for liquidity and runway */
  costLookbackMonths: integer('cost_lookback_months').notNull().default(3),

  /* Radar de risco thresholds, all in basis points so they match the
   * `...Bps` convention every other percentage in this schema uses. */
  /** card bill ÷ average income above this is flagged: 3500 = 35% */
  riskCardShareBps: integer('risk_card_share_bps').notNull().default(3500),
  /** reserve coverage below this is flagged: 10000 = 100% of the target */
  riskReserveCoverageBps: integer('risk_reserve_coverage_bps').notNull().default(10_000),
  /** allocation drift above this is flagged: 1000 = 10 p.p. */
  riskAllocationDriftBps: integer('risk_allocation_drift_bps').notNull().default(1_000),
  /** spending above this share of the month's cap is flagged: 10000 = 100% */
  riskSpendingCapBps: integer('risk_spending_cap_bps').notNull().default(10_000),
  /** debt service above this share of income is flagged: 3000 = 30% */
  riskDebtToIncomeBps: integer('risk_debt_to_income_bps').notNull().default(3_000),

  /**
   * How far past a threshold an indicator has to be before the radar calls it
   * a POSITIVE outlier, in basis points of slack: 2000 = 20 p.p. Independent
   * from being inside the range, so an indicator can sit comfortably within
   * its limit without clearing this margin (see `specs/financial-health`,
   * "Radar de risco, sinal positivo").
   */
  riskPositiveMarginBps: integer('risk_positive_margin_bps').notNull().default(2_000),
})

/**
 * Financial-engine parameters, same singleton shape and same reason as
 * `financial_health_settings` above: these are the user's own choices, not
 * derived data, and a choice that lives only in code is a judgement the
 * product made on their behalf (decisions/0010).
 *
 * Everything derivable is deliberately NOT here. Custos PJ come from the
 * ledger, the reserve gap from `specs/investments`, and pró-labore from the
 * paired PJ to PF transfer (`services/transfers.ts`) — `proLaboreCents` is an
 * override for when the paired flow is not the whole story, null meaning
 * "derive it", never a second copy of a number the ledger already knows.
 */
export const financialEngineSettings = sqliteTable('financial_engine_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  /** which account holds the PJ books; null reads the whole ledger */
  pjAccountId: integer('pj_account_id').references(() => accounts.id, { onDelete: 'set null' }),
  /** which account receives the pró-labore; null disables the paired-flow derivation */
  pfAccountId: integer('pf_account_id').references(() => accounts.id, { onDelete: 'set null' }),

  /** overrides the derived pró-labore; null keeps deriving it from the ledger */
  proLaboreCents: integer('pro_labore_cents'),
  /** tax as a share of revenue, basis points; 0 = not configured */
  taxRateBps: integer('tax_rate_bps').notNull().default(0),
  /**
   * What the user plans to put toward the reserve this month. Defaults to 0
   * rather than to the reserve gap on purpose: assuming the whole gap closes
   * inside one month would be the system setting the user's pace. The gap
   * travels in the response's `assumptions` as a reference instead.
   */
  reservePlannedCents: integer('reserve_planned_cents').notNull().default(0),
  /** margin the user wants on top of everything else */
  marginCents: integer('margin_cents').notNull().default(0),
})

/* ------------------------------------------------------------------ *
 * Precificação de projetos
 *
 * What this does NOT store is the point: no cost, no pró-labore, no tax
 * rate, no monthly margin. All of those already live in
 * `financial_engine_settings`, and the hourly rate is derived from the same
 * break-even the motor already computes (see `decisions/0012`). Duplicating
 * any of them here would create a second "how much do I need to bill" that
 * could disagree with the first.
 * ------------------------------------------------------------------ */

/** Singleton (id always 1), same shape as the other settings tables. */
export const pricingSettings = sqliteTable('pricing_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 176 = 22 working days x 8h */
  availableHoursPerMonth: integer('available_hours_per_month').notNull().default(176),
  /**
   * Share of those hours that actually gets billed. Nobody bills 100% of a
   * month: prospecting, admin and unbilled revisions eat into it.
   */
  billablePercentageBps: integer('billable_percentage_bps').notNull().default(6_000),
})

/**
 * The multiplier bank, editable per dimension — same pattern as `criteria`
 * (the Diagrama do Cerrado question bank): seeded with suggestions, not
 * frozen constants, because what counts as "complex" varies by trade.
 */
export const pricingMultiplierOptions = sqliteTable(
  'pricing_multiplier_options',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** complexity | urgency | client_size | usage_rights */
    dimension: text('dimension').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    /** 10000 = 1.0x */
    multiplierBps: integer('multiplier_bps').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [index('pricing_multiplier_dimension_idx').on(t.dimension)],
)

/**
 * A saved quote. The three output numbers are FROZEN at simulation time,
 * never recalculated: a price already sent to a client must not change
 * because the user edited their monthly costs the following week.
 */
export const projectQuotes = sqliteTable('project_quotes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** free text until a client/project table exists */
  clientLabel: text('client_label').notNull(),
  estimatedHours: real('estimated_hours').notNull(),
  /** {label, amountCents}[] */
  directCosts: text('direct_costs', { mode: 'json' }).notNull().default('[]'),
  complexityOptionId: integer('complexity_option_id').references(() => pricingMultiplierOptions.id, {
    onDelete: 'set null',
  }),
  urgencyOptionId: integer('urgency_option_id').references(() => pricingMultiplierOptions.id, {
    onDelete: 'set null',
  }),
  clientSizeOptionId: integer('client_size_option_id').references(() => pricingMultiplierOptions.id, {
    onDelete: 'set null',
  }),
  usageRightsOptionId: integer('usage_rights_option_id').references(() => pricingMultiplierOptions.id, {
    onDelete: 'set null',
  }),
  extraMarginBps: integer('extra_margin_bps').notNull().default(0),
  hourlyBaseCents: integer('hourly_base_cents').notNull(),
  minimumPriceCents: integer('minimum_price_cents').notNull(),
  recommendedPriceCents: integer('recommended_price_cents').notNull(),
  /** draft | sent | in_review | needs_changes | rejected | approved — always manually editable, never a locked state machine */
  status: text('status').notNull().default('draft'),
  createdAt: text('created_at').notNull().default(now),
  /** Last edit, distinct from createdAt — decisions/0021, an edit recomputes the frozen numbers. */
  updatedAt: text('updated_at').notNull().default(now),
})
