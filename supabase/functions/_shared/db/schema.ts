import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

/**
 * Traduzido de SQLite (better-sqlite3) para Postgres (Supabase) na Fase 3
 * de decisions/0026. Nomes de export e de propriedade continuam idênticos
 * de propósito — é o que todo o resto do backend importa como
 * `schema.<tabela>.<coluna>` — só o dialeto por baixo mudou. Fonte de
 * verdade do shape real das tabelas: supabase/migrations/*.sql (já
 * aplicadas e verificadas contra o dado real nas Fases 1-2).
 */

const now = sql`now_iso()`
const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity()
/** Tabelas singleton (settings): id é a constante 1, não uma identity — ver 20260828002409_fix_singleton_id_default.sql */
const singletonId = () => bigint('id', { mode: 'number' }).primaryKey().default(1)
const int = (name: string) => bigint(name, { mode: 'number' })

/* ------------------------------------------------------------------ *
 * Enumerated types — um por "kind"/"status" antes documentado só em
 * comentário no schema.ts; agora validado pelo próprio Postgres.
 * ------------------------------------------------------------------ */
export const accountKindEnum = pgEnum('account_kind', [
  'checking',
  'savings',
  'credit_card',
  'investment',
  'loan',
  'cash',
])
export const csvDelimiterEnum = pgEnum('csv_delimiter', [',', ';', 'tab', 'auto'])
export const csvDateFormatEnum = pgEnum('csv_date_format', [
  'dd/MM/yyyy',
  'yyyy-MM-dd',
  'dd-MM-yyyy',
  'dd/MM/yy',
])
export const csvSignConventionEnum = pgEnum('csv_sign_convention', [
  'signed',
  'signed_inverted',
  'debit_credit',
  'type_flag',
])
export const categoryKindEnum = pgEnum('category_kind', ['income', 'expense', 'transfer', 'investment'])
/**
 * Onde uma categoria entra no DRE formal (specs/dre, "DRE PJ formal") —
 * null é o padrão implícito (Receita Bruta pra income, Despesa
 * Operacional pra expense), nunca gravado à parte porque não precisa:
 * são os dois maiores baldes, tudo que não foi classificado explicitamente
 * cai neles. Só existe pra categorias-mãe (parentId is null) — uma
 * subcategoria herda da mãe, igual já faz com cor e kind.
 */
export const dreGroupEnum = pgEnum('dre_group', ['deduction', 'cost', 'financial', 'tax'])
export const ruleFieldEnum = pgEnum('rule_field', ['description', 'raw_category'])
export const ruleMatchTypeEnum = pgEnum('rule_match_type', ['contains', 'starts_with', 'equals', 'regex'])
export const ruleDirectionEnum = pgEnum('rule_direction', ['any', 'in', 'out'])
export const ruleOriginEnum = pgEnum('rule_origin', ['user', 'learned'])
export const duplicateStatusEnum = pgEnum('duplicate_status', ['none', 'in_batch', 'in_ledger'])
export const suggestionSourceEnum = pgEnum('suggestion_source', ['rule', 'memory', 'raw_category', 'none'])
export const importStatusEnum = pgEnum('import_status', ['staged', 'committed', 'discarded'])
export const txnSourceEnum = pgEnum('txn_source', ['csv', 'manual', 'daily', 'adjustment'])
export const categorizedByEnum = pgEnum('categorized_by', ['rule', 'memory', 'manual', 'raw_category', 'none'])
export const txnDirectionEnum = pgEnum('txn_direction', ['in', 'out'])
export const debtKindEnum = pgEnum('debt_kind', [
  'credit_card',
  'personal_loan',
  'financing',
  'overdraft',
  'student',
  'other',
])
export const debtPaymentKindEnum = pgEnum('debt_payment_kind', ['payment', 'charge'])
/** stocks | fii | fixed_income | treasury | crypto | funds | etf_intl | cash | pension | other — ver ASSET_CLASSES em services/investments.ts, a fonte de verdade real */
export const assetClassKindEnum = pgEnum('asset_class_kind', [
  'stocks',
  'fii',
  'fixed_income',
  'treasury',
  'crypto',
  'funds',
  'etf_intl',
  'cash',
  'pension',
  'other',
])
export const forecastKindEnum = pgEnum('forecast_kind', ['recurring', 'installment', 'single'])
export const tradeKindEnum = pgEnum('trade_kind', ['buy', 'sell', 'dividend'])
export const benchmarkCodeEnum = pgEnum('benchmark_code', ['CDI', 'IPCA', 'IBOV', 'IFIX', 'SMLL', 'IDIV', 'IVVB11'])
export const benchmarkSourceEnum = pgEnum('benchmark_source', ['bcb', 'brapi_etf'])
export const investmentGoalPurposeEnum = pgEnum('investment_goal_purpose', [
  'retirement',
  'buy_property',
  'financial_independence',
  'children_education',
  'travel',
])
export const pricingDimensionEnum = pgEnum('pricing_dimension', [
  'complexity',
  'urgency',
  'client_size',
  'usage_rights',
])
export const quoteStatusEnum = pgEnum('quote_status', [
  'draft',
  'sent',
  'in_review',
  'needs_changes',
  'rejected',
  'approved',
])

/* ------------------------------------------------------------------ *
 * Accounts — multi-account from day one, even though v1 is one user.
 * ------------------------------------------------------------------ */
export const accounts = pgTable('accounts', {
  id: id(),
  name: text('name').notNull(),
  institution: text('institution').notNull(),
  kind: accountKindEnum('kind').notNull().default('checking'),
  currency: text('currency').notNull().default('BRL'),
  openingBalanceCents: int('opening_balance_cents').notNull().default(0),
  archived: boolean('archived').notNull().default(false),
  createdAt: text('created_at').notNull().default(now),
})

/* ------------------------------------------------------------------ *
 * Category tree — parent row plus children. One level of nesting is
 * the product contract; the schema allows deeper without migration.
 * ------------------------------------------------------------------ */
export const categories = pgTable(
  'categories',
  {
    id: id(),
    parentId: int('parent_id').references((): AnyPgColumn => categories.id),
    name: text('name').notNull(),
    kind: categoryKindEnum('kind').notNull().default('expense'),
    color: text('color').notNull().default('#2a78d6'),
    icon: text('icon').notNull().default('tag'),
    dreGroup: dreGroupEnum('dre_group'),
    sortOrder: int('sort_order').notNull().default(0),
    archived: boolean('archived').notNull().default(false),
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
export const categoryRules = pgTable(
  'category_rules',
  {
    id: id(),
    categoryId: int('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    field: ruleFieldEnum('field').notNull().default('description'),
    matchType: ruleMatchTypeEnum('match_type').notNull().default('contains'),
    pattern: text('pattern').notNull(),
    direction: ruleDirectionEnum('direction').notNull().default('any'),
    amountMinCents: int('amount_min_cents'),
    amountMaxCents: int('amount_max_cents'),
    accountId: int('account_id').references(() => accounts.id),
    priority: int('priority').notNull().default(100),
    origin: ruleOriginEnum('origin').notNull().default('user'),
    hitCount: int('hit_count').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('category_rules_category_idx').on(t.categoryId),
    index('category_rules_account_idx').on(t.accountId),
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
export const categoryMemory = pgTable(
  'category_memory',
  {
    id: id(),
    signature: text('signature').notNull(),
    categoryId: int('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    hits: int('hits').notNull().default(1),
    promotedRuleId: int('promoted_rule_id').references(() => categoryRules.id, { onDelete: 'set null' }),
    lastSeenAt: text('last_seen_at').notNull().default(now),
  },
  (t) => [
    index('category_memory_category_idx').on(t.categoryId),
    index('category_memory_promoted_rule_idx').on(t.promotedRuleId),
    uniqueIndex('category_memory_uq').on(t.signature, t.categoryId),
  ],
)

/* ------------------------------------------------------------------ *
 * Parser profiles — a bank's CSV dialect expressed as DATA, so adding
 * a bank is a row, never a code change in the import pipeline.
 * ------------------------------------------------------------------ */
export const parserProfiles = pgTable(
  'parser_profiles',
  {
    id: id(),
    name: text('name').notNull(),
    institution: text('institution').notNull(),
    delimiter: csvDelimiterEnum('delimiter').notNull().default(';'),
    encoding: text('encoding').notNull().default('utf-8'),
    dateFormat: csvDateFormatEnum('date_format').notNull().default('dd/MM/yyyy'),
    decimalSeparator: text('decimal_separator').notNull().default(','),
    thousandsSeparator: text('thousands_separator').notNull().default('.'),
    signConvention: csvSignConventionEnum('sign_convention').notNull().default('signed'),
    hasHeader: boolean('has_header').notNull().default(true),
    skipRows: int('skip_rows').notNull().default(0),
    /** JSON map of logical field to CSV header name (or numeric index) */
    columnMap: jsonb('column_map').notNull(),
    /** JSON string[] — header tokens used to auto-detect this profile */
    headerSignature: jsonb('header_signature').notNull(),
    /** JSON string[] — rows matching these are dropped (totals, balance lines) */
    ignorePatterns: jsonb('ignore_patterns').notNull(),
    defaultAccountId: int('default_account_id').references(() => accounts.id),
    active: boolean('active').notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('parser_profiles_default_account_idx').on(t.defaultAccountId),
    uniqueIndex('parser_profiles_name_uq').on(t.name),
  ],
)

/* ------------------------------------------------------------------ *
 * Import staging — nothing reaches `transactions` before review.
 * ------------------------------------------------------------------ */
export const importBatches = pgTable(
  'import_batches',
  {
    id: id(),
    profileId: int('profile_id').references(() => parserProfiles.id),
    accountId: int('account_id')
      .notNull()
      .references(() => accounts.id),
    filename: text('filename').notNull(),
    rowCount: int('row_count').notNull().default(0),
    parsedCount: int('parsed_count').notNull().default(0),
    duplicateCount: int('duplicate_count').notNull().default(0),
    errorCount: int('error_count').notNull().default(0),
    committedCount: int('committed_count').notNull().default(0),
    status: importStatusEnum('status').notNull().default('staged'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('import_batches_profile_idx').on(t.profileId), index('import_batches_account_idx').on(t.accountId)],
)

export const stagedTransactions = pgTable(
  'staged_transactions',
  {
    id: id(),
    batchId: int('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    rowIndex: int('row_index').notNull(),
    postedOn: text('posted_on'),
    description: text('description').notNull().default(''),
    descriptionNorm: text('description_norm').notNull().default(''),
    amountCents: int('amount_cents'),
    rawCategory: text('raw_category'),
    dedupeHash: text('dedupe_hash'),
    duplicateOf: duplicateStatusEnum('duplicate_of').notNull().default('none'),
    // Sem FK de propósito: uma linha em staging pode apontar para uma
    // transaction que ainda nem existe na hora de detectar duplicata
    // dentro do próprio lote.
    duplicateTxnId: int('duplicate_txn_id'),
    suggestedCategoryId: int('suggested_category_id').references(() => categories.id),
    suggestionSource: suggestionSourceEnum('suggestion_source').notNull().default('none'),
    suggestionDetail: text('suggestion_detail'),
    /** the reviewer's choice; falls back to the suggestion on commit */
    categoryId: int('category_id').references(() => categories.id),
    include: boolean('include').notNull().default(true),
    parseError: text('parse_error'),
    rawLine: text('raw_line'),
  },
  (t) => [
    index('staged_batch_idx').on(t.batchId),
    index('staged_suggested_category_idx').on(t.suggestedCategoryId),
    index('staged_category_idx').on(t.categoryId),
  ],
)

/* ------------------------------------------------------------------ *
 * transactions — THE single source of truth. Every dashboard is an
 * aggregation over this table; there are no derived report tables.
 * ------------------------------------------------------------------ */
export const transactions = pgTable(
  'transactions',
  {
    id: id(),
    accountId: int('account_id')
      .notNull()
      .references(() => accounts.id),
    /** ISO date YYYY-MM-DD — sorts chronologically as text */
    postedOn: text('posted_on').notNull(),
    description: text('description').notNull(),
    descriptionNorm: text('description_norm').notNull().default(''),
    /** signed integer cents: negative = money out, positive = money in */
    amountCents: int('amount_cents').notNull(),
    /** derived from the sign, stored so aggregations skip CASE everywhere */
    direction: txnDirectionEnum('direction').notNull(),
    categoryId: int('category_id').references(() => categories.id, { onDelete: 'set null' }),
    rawCategory: text('raw_category'),
    source: txnSourceEnum('source').notNull().default('csv'),
    categorizedBy: categorizedByEnum('categorized_by').notNull().default('none'),
    ruleId: int('rule_id').references(() => categoryRules.id, { onDelete: 'set null' }),
    importBatchId: int('import_batch_id').references(() => importBatches.id, { onDelete: 'set null' }),
    dedupeHash: text('dedupe_hash').notNull(),
    /** set when the reviewer knowingly kept a flagged duplicate */
    duplicateAccepted: boolean('duplicate_accepted').notNull().default(false),
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
    pending: boolean('pending').notNull().default(false),
    /** the recurring/installment template that materialized this row, if any */
    forecastId: int('forecast_id').references(() => cashFlowForecasts.id, { onDelete: 'cascade' }),
    /** the debt whose remaining parcela this row materializes, if any */
    debtId: int('debt_id').references(() => debts.id, { onDelete: 'cascade' }),
    /** the approved quote whose revenue this row is, if any (decisions/0032 follow-up) */
    sourceQuoteId: int('source_quote_id').references(() => projectQuotes.id, { onDelete: 'set null' }),
    /**
     * The YYYY-MM occurrence a materialized row fills, fixed at creation
     * time — independent of `postedOn`, which the user can freely edit
     * without that edit being mistaken for "this occurrence never
     * happened" (see decisions/0017).
     */
    occurrencePeriod: text('occurrence_period'),
    /**
     * Set the first time the user edits postedOn/description/amountCents
     * of a pending row tied to a forecast or debt template. Once true,
     * syncMaterializedRows skips the row entirely on the next template
     * edit (decisions/0017).
     */
    manuallyEdited: boolean('manually_edited').notNull().default(false),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    index('txn_posted_idx').on(t.postedOn),
    index('txn_account_posted_idx').on(t.accountId, t.postedOn),
    index('txn_category_idx').on(t.categoryId),
    index('txn_dedupe_idx').on(t.accountId, t.dedupeHash),
    index('txn_pending_idx').on(t.pending),
    index('txn_rule_idx').on(t.ruleId),
    index('txn_import_batch_idx').on(t.importBatchId),
    index('txn_forecast_idx').on(t.forecastId),
    index('txn_debt_idx').on(t.debtId),
    index('txn_source_quote_idx').on(t.sourceQuoteId),
    // Guards the race in materialize()/materializeDebtInstallments(): two
    // concurrent calls both seeing "period missing" before either INSERT
    // commits used to be able to double-insert the same pending occurrence.
    // NULLs are never equal to each other in Postgres, so legacy rows
    // materialized before occurrencePeriod existed (occurrence_period is
    // null) never conflict with one another.
    uniqueIndex('txn_forecast_occurrence_uq')
      .on(t.forecastId, t.occurrencePeriod)
      .where(sql`${t.forecastId} is not null`),
    uniqueIndex('txn_debt_occurrence_uq')
      .on(t.debtId, t.occurrencePeriod)
      .where(sql`${t.debtId} is not null`),
  ],
)

/* ------------------------------------------------------------------ *
 * Debt
 * ------------------------------------------------------------------ */
export const debts = pgTable(
  'debts',
  {
    id: id(),
    name: text('name').notNull(),
    kind: debtKindEnum('kind').notNull().default('credit_card'),
    institution: text('institution'),
    principalCents: int('principal_cents').notNull().default(0),
    /** annual nominal rate in basis points: 1200 = 12.00% a.a. */
    aprBps: int('apr_bps').notNull().default(0),
    minimumPaymentCents: int('minimum_payment_cents').notNull().default(0),
    scheduledPaymentCents: int('scheduled_payment_cents').notNull().default(0),
    dueDay: int('due_day').notNull().default(10),
    /** total parcelas in the contract — null for revolving debt (cartão, cheque especial) that has none */
    installmentCount: int('installment_count'),
    /** optional last period a revolving debt still materializes a pendency for — mirrors cashFlowForecasts.endPeriod */
    endPeriod: text('end_period'),
    accountId: int('account_id').references(() => accounts.id),
    openedOn: text('opened_on'),
    closedOn: text('closed_on'),
    active: boolean('active').notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('debts_account_idx').on(t.accountId)],
)

/** Balance history, so the debt trend is measured rather than guessed. */
export const debtSnapshots = pgTable(
  'debt_snapshots',
  {
    id: id(),
    debtId: int('debt_id')
      .notNull()
      .references(() => debts.id, { onDelete: 'cascade' }),
    asOf: text('as_of').notNull(),
    balanceCents: int('balance_cents').notNull(),
  },
  (t) => [uniqueIndex('debt_snapshot_uq').on(t.debtId, t.asOf)],
)

/**
 * The payment ledger — a log of real events (parcela paga, novo uso/
 * saque) the UI can show and count, entirely separate from
 * `debt_snapshots` (the measured balance).
 */
export const debtPayments = pgTable(
  'debt_payments',
  {
    id: id(),
    debtId: int('debt_id')
      .notNull()
      .references(() => debts.id, { onDelete: 'cascade' }),
    kind: debtPaymentKindEnum('kind').notNull().default('payment'),
    paidOn: text('paid_on').notNull(),
    amountCents: int('amount_cents').notNull(),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('debt_payments_debt_idx').on(t.debtId, t.paidOn)],
)

/* ------------------------------------------------------------------ *
 * Credit cards
 * ------------------------------------------------------------------ */
export const creditCards = pgTable(
  'credit_cards',
  {
    id: id(),
    name: text('name').notNull(),
    institution: text('institution'),
    /** the checking account whose statement pays this card's bill */
    accountId: int('account_id').references(() => accounts.id),
    creditLimitCents: int('credit_limit_cents').notNull().default(0),
    closingDay: int('closing_day').notNull().default(1),
    dueDay: int('due_day').notNull().default(10),
    active: boolean('active').notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('credit_cards_account_idx').on(t.accountId)],
)

export const creditCardSnapshots = pgTable(
  'credit_card_snapshots',
  {
    id: id(),
    cardId: int('card_id')
      .notNull()
      .references(() => creditCards.id, { onDelete: 'cascade' }),
    asOf: text('as_of').notNull(),
    availableLimitCents: int('available_limit_cents').notNull(),
  },
  (t) => [uniqueIndex('credit_card_snapshot_uq').on(t.cardId, t.asOf)],
)

/* ------------------------------------------------------------------ *
 * Monthly goals
 * ------------------------------------------------------------------ */
export const monthlyGoals = pgTable(
  'monthly_goals',
  {
    id: id(),
    /** YYYY-MM */
    period: text('period').notNull(),
    incomeTargetCents: int('income_target_cents'),
    spendCapCents: int('spend_cap_cents'),
    /** basis points: 2000 = 20% */
    savingsRateTargetBps: int('savings_rate_target_bps'),
    note: text('note'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('monthly_goals_period_uq').on(t.period)],
)

export const categoryCaps = pgTable(
  'category_caps',
  {
    id: id(),
    period: text('period').notNull(),
    categoryId: int('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    capCents: int('cap_cents').notNull(),
  },
  (t) => [index('category_caps_category_idx').on(t.categoryId), uniqueIndex('category_caps_uq').on(t.period, t.categoryId)],
)

/* ------------------------------------------------------------------ *
 * Investments
 * ------------------------------------------------------------------ */
export const assets = pgTable(
  'assets',
  {
    id: id(),
    name: text('name').notNull(),
    ticker: text('ticker'),
    assetClass: assetClassKindEnum('asset_class').notNull().default('stocks'),
    /** BRAPI's summaryProfile.sector (e.g. "Energia", "Bancos") — populated on quote refresh, null until then */
    sector: text('sector'),
    currency: text('currency').notNull().default('BRL'),
    accountId: int('account_id').references(() => accounts.id),
    /** counts toward the emergency-reserve progress (e.g. a CDB/Tesouro Selic held as reserve) */
    countsTowardReserve: boolean('counts_toward_reserve').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('assets_account_idx').on(t.accountId), uniqueIndex('assets_name_uq').on(t.name)],
)

/**
 * Singleton settings row (id is always 1) — the reserve TARGET is a
 * multiple of monthly cost of living, computed fresh from real expense
 * data rather than stored, so it tracks spending as it changes.
 */
export const emergencyReserveSettings = pgTable(
  'emergency_reserve_settings',
  {
    id: singletonId(),
    /** months of living cost to hold: 6, 12, or 24 */
    multiple: int('multiple').notNull().default(6),
    lookbackMonths: int('lookback_months').notNull().default(3),
    /** overrides the computed average when set; null means "use the computed average" */
    manualLivingCostCents: int('manual_living_cost_cents'),
  },
  () => [check('emergency_reserve_settings_singleton', sql`id = 1`)],
)

/**
 * A recurring retainer or an already-agreed installment deal — the
 * template that materializes real rows into `transactions` (pending =
 * true) for every future occurrence, rather than a separate preview.
 */
export const cashFlowForecasts = pgTable(
  'cash_flow_forecasts',
  {
    id: id(),
    description: text('description').notNull(),
    kind: forecastKindEnum('kind').notNull().default('recurring'),
    amountCents: int('amount_cents').notNull(),
    /** the account this is expected to post to once real */
    accountId: int('account_id').references(() => accounts.id),
    categoryId: int('category_id').references(() => categories.id, { onDelete: 'set null' }),
    /** YYYY-MM of the first occurrence (recurring) or installment #1 (installment) */
    startPeriod: text('start_period').notNull(),
    /** day of month the money is expected to land */
    dueDay: int('due_day').notNull().default(1),
    /** total parcelas — null for recurring, which has no end */
    installmentCount: int('installment_count'),
    /** how many parcelas are already confirmed/received, e.g. 1 of 3 */
    installmentsRealized: int('installments_realized').notNull().default(0),
    /** optional last period for a recurring entry that has a known end */
    endPeriod: text('end_period'),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('cash_flow_forecasts_account_idx').on(t.accountId), index('cash_flow_forecasts_category_idx').on(t.categoryId)],
)

/** A suggested (pending, real) pair the user said is NOT a match. */
export const reconciliationDismissals = pgTable(
  'reconciliation_dismissals',
  {
    id: id(),
    // Sem FK de propósito: referencia a linha "pending" genérica
    // (transaction OU forecast), não uma tabela só.
    pendingId: int('pending_id').notNull(),
    matchId: int('match_id').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('reconciliation_dismissals_uq').on(t.pendingId, t.matchId)],
)

/** A recurring/installment occurrence the user explicitly deleted — not "not yet materialized" but "never happening". */
export const skippedOccurrences = pgTable(
  'skipped_occurrences',
  {
    id: id(),
    forecastId: int('forecast_id').references(() => cashFlowForecasts.id, { onDelete: 'cascade' }),
    debtId: int('debt_id').references(() => debts.id, { onDelete: 'cascade' }),
    /** YYYY-MM */
    period: text('period').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('skipped_occurrences_forecast_idx').on(t.forecastId),
    index('skipped_occurrences_debt_idx').on(t.debtId),
    // Split in two, both partial: a plain unique index on (forecastId,
    // debtId, period) never fires here, because forecastId/debtId are
    // nullable and every real row has exactly one of them null — Postgres
    // never treats two NULLs as equal, so the old single index gave false
    // confidence while never actually deduping (found in the 28/08/2026
    // review, same defect the txn_*_occurrence_uq indexes below had).
    uniqueIndex('skipped_occurrences_forecast_uq')
      .on(t.forecastId, t.period)
      .where(sql`${t.forecastId} is not null`),
    uniqueIndex('skipped_occurrences_debt_uq')
      .on(t.debtId, t.period)
      .where(sql`${t.debtId} is not null`),
  ],
)

/** Contributions and withdrawals — the "contributed capital" line. */
export const assetTrades = pgTable(
  'asset_trades',
  {
    id: id(),
    assetId: int('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    kind: tradeKindEnum('kind').notNull().default('buy'),
    tradedOn: text('traded_on').notNull(),
    quantity: doublePrecision('quantity').notNull().default(0),
    unitPriceCents: int('unit_price_cents').notNull().default(0),
    feesCents: int('fees_cents').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('asset_trades_asset_idx').on(t.assetId, t.tradedOn)],
)

/** Marks to market — the "portfolio value" line. */
export const assetValuations = pgTable(
  'asset_valuations',
  {
    id: id(),
    assetId: int('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    asOf: text('as_of').notNull(),
    unitPriceCents: int('unit_price_cents').notNull(),
  },
  (t) => [uniqueIndex('asset_valuations_uq').on(t.assetId, t.asOf)],
)

/**
 * Monthly return of the portfolio's benchmarks — CDI/IPCA from the
 * Banco Central's SGS API and B3 index proxies approximated from the
 * ETF that tracks each one via BRAPI.
 */
export const benchmarkReturns = pgTable(
  'benchmark_returns',
  {
    id: id(),
    code: benchmarkCodeEnum('code').notNull(),
    period: text('period').notNull(),
    returnBps: int('return_bps').notNull(),
    source: benchmarkSourceEnum('source').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('benchmark_returns_uq').on(t.code, t.period)],
)

export const investmentGoals = pgTable('investment_goals', {
  id: id(),
  name: text('name').notNull(),
  targetValueCents: int('target_value_cents').notNull().default(0),
  targetDate: text('target_date'),
  monthlyContributionCents: int('monthly_contribution_cents').notNull().default(0),
  /** expected annual return, basis points */
  expectedReturnBps: int('expected_return_bps').notNull().default(800),
  /**
   * retirement | buy_property | financial_independence | children_education | travel
   * — purely an organizing label; never read by suggestContribution or any
   * other calculation (decisions/0010). Null when the user leaves it unset.
   */
  purpose: investmentGoalPurposeEnum('purpose'),
  active: boolean('active').notNull().default(true),
  createdAt: text('created_at').notNull().default(now),
})

export const targetAllocations = pgTable(
  'target_allocations',
  {
    id: id(),
    goalId: int('goal_id').references(() => investmentGoals.id, { onDelete: 'cascade' }),
    assetClass: assetClassKindEnum('asset_class').notNull(),
    /** basis points of the portfolio: 3000 = 30% */
    targetBps: int('target_bps').notNull(),
  },
  (t) => [
    index('target_allocations_goal_idx').on(t.goalId),
    // Split in two, both partial: `goalId is null` means "global policy"
    // (a real, used case, not an absence of one) — a plain unique index on
    // (goalId, assetClass) never fires for those rows, same NULL-defeats-
    // uniqueness defect as skipped_occurrences above.
    uniqueIndex('target_alloc_goal_uq')
      .on(t.goalId, t.assetClass)
      .where(sql`${t.goalId} is not null`),
    uniqueIndex('target_alloc_global_uq')
      .on(t.assetClass)
      .where(sql`${t.goalId} is null`),
  ],
)

/* ------------------------------------------------------------------ *
 * Resistance scoring ("Diagrama do Cerrado") — a yes/no questionnaire
 * per asset class.
 * ------------------------------------------------------------------ */
export const criteria = pgTable(
  'criteria',
  {
    id: id(),
    assetClass: assetClassKindEnum('asset_class').notNull(),
    label: text('label').notNull(),
    sortOrder: int('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('criteria_class_idx').on(t.assetClass)],
)

export const assetCriteriaAnswers = pgTable(
  'asset_criteria_answers',
  {
    id: id(),
    assetId: int('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    criteriaId: int('criteria_id')
      .notNull()
      .references(() => criteria.id, { onDelete: 'cascade' }),
    checked: boolean('checked').notNull(),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    index('asset_criteria_answers_asset_idx').on(t.assetId),
    index('asset_criteria_answers_criteria_idx').on(t.criteriaId),
    uniqueIndex('asset_criteria_uq').on(t.assetId, t.criteriaId),
  ],
)

/* ------------------------------------------------------------------ *
 * Financial-health parameters — the ONLY thing the intelligence layer
 * stores (decisions/0010). Singleton row, id always 1.
 * ------------------------------------------------------------------ */
export const financialHealthSettings = pgTable(
  'financial_health_settings',
  {
    id: singletonId(),
    weightLiquidity: int('weight_liquidity').notNull().default(20),
    weightDebt: int('weight_debt').notNull().default(20),
    weightSpending: int('weight_spending').notNull().default(20),
    weightReserve: int('weight_reserve').notNull().default(20),
    weightAllocation: int('weight_allocation').notNull().default(20),
    costLookbackMonths: int('cost_lookback_months').notNull().default(3),
    riskCardShareBps: int('risk_card_share_bps').notNull().default(3500),
    riskReserveCoverageBps: int('risk_reserve_coverage_bps').notNull().default(10_000),
    riskAllocationDriftBps: int('risk_allocation_drift_bps').notNull().default(1_000),
    riskSpendingCapBps: int('risk_spending_cap_bps').notNull().default(10_000),
    riskDebtToIncomeBps: int('risk_debt_to_income_bps').notNull().default(3_000),
    riskPositiveMarginBps: int('risk_positive_margin_bps').notNull().default(2_000),
  },
  () => [check('financial_health_settings_singleton', sql`id = 1`)],
)

/**
 * Financial-engine parameters, same singleton shape and reason as
 * `financial_health_settings` (decisions/0010).
 */
export const financialEngineSettings = pgTable(
  'financial_engine_settings',
  {
    id: singletonId(),
    /** which account holds the PJ books; null reads the whole ledger */
    pjAccountId: int('pj_account_id').references(() => accounts.id, { onDelete: 'set null' }),
    /** which account receives the pró-labore; null disables the paired-flow derivation */
    pfAccountId: int('pf_account_id').references(() => accounts.id, { onDelete: 'set null' }),
    /** overrides the derived pró-labore; null keeps deriving it from the ledger */
    proLaboreCents: int('pro_labore_cents'),
    taxRateBps: int('tax_rate_bps').notNull().default(0),
    reservePlannedCents: int('reserve_planned_cents').notNull().default(0),
    marginCents: int('margin_cents').notNull().default(0),
  },
  (t) => [
    index('financial_engine_settings_pj_account_idx').on(t.pjAccountId),
    index('financial_engine_settings_pf_account_idx').on(t.pfAccountId),
    check('financial_engine_settings_singleton', sql`id = 1`),
  ],
)

/* ------------------------------------------------------------------ *
 * Precificação de projetos (decisions/0012)
 * ------------------------------------------------------------------ */
export const pricingSettings = pgTable(
  'pricing_settings',
  {
    id: singletonId(),
    /** 176 = 22 working days x 8h */
    availableHoursPerMonth: int('available_hours_per_month').notNull().default(176),
    billablePercentageBps: int('billable_percentage_bps').notNull().default(6_000),
  },
  () => [check('pricing_settings_singleton', sql`id = 1`)],
)

export const pricingMultiplierOptions = pgTable(
  'pricing_multiplier_options',
  {
    id: id(),
    dimension: pricingDimensionEnum('dimension').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    /** 10000 = 1.0x */
    multiplierBps: int('multiplier_bps').notNull(),
    sortOrder: int('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
  },
  (t) => [index('pricing_multiplier_dimension_idx').on(t.dimension)],
)

/**
 * A saved quote. The three output numbers are FROZEN at simulation
 * time, never recalculated (decisions/0021).
 */
export const projectQuotes = pgTable(
  'project_quotes',
  {
    id: id(),
    /** free text until a client/project table exists */
    clientLabel: text('client_label').notNull(),
    estimatedHours: doublePrecision('estimated_hours').notNull(),
    /** {label, amountCents}[] */
    directCosts: jsonb('direct_costs').notNull().default(sql`'[]'::jsonb`),
    complexityOptionId: int('complexity_option_id').references(() => pricingMultiplierOptions.id, {
      onDelete: 'set null',
    }),
    urgencyOptionId: int('urgency_option_id').references(() => pricingMultiplierOptions.id, { onDelete: 'set null' }),
    clientSizeOptionId: int('client_size_option_id').references(() => pricingMultiplierOptions.id, {
      onDelete: 'set null',
    }),
    usageRightsOptionId: int('usage_rights_option_id').references(() => pricingMultiplierOptions.id, {
      onDelete: 'set null',
    }),
    extraMarginBps: int('extra_margin_bps').notNull().default(0),
    hourlyBaseCents: int('hourly_base_cents').notNull(),
    minimumPriceCents: int('minimum_price_cents').notNull(),
    recommendedPriceCents: int('recommended_price_cents').notNull(),
    /** recommendedPriceCents × 1.3 — a third anchor point, never a fourth price the API lets you approve at (`services/pricing.ts`) */
    premiumPriceCents: int('premium_price_cents').notNull(),
    /** what was actually negotiated at approval — null until approved; approveQuote defaults it to recommendedPriceCents when the user doesn't override it, never silently different from what the ledger transaction actually used */
    actualPriceCents: int('actual_price_cents'),
    status: quoteStatusEnum('status').notNull().default('draft'),
    createdAt: text('created_at').notNull().default(now),
    /** Last edit, distinct from createdAt — decisions/0021, an edit recomputes the frozen numbers. */
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    index('project_quotes_complexity_idx').on(t.complexityOptionId),
    index('project_quotes_urgency_idx').on(t.urgencyOptionId),
    index('project_quotes_client_size_idx').on(t.clientSizeOptionId),
    index('project_quotes_usage_rights_idx').on(t.usageRightsOptionId),
  ],
)

/* ------------------------------------------------------------------ *
 * Usage events — tela aberta, ação-chave feita, erro exibido ao
 * usuário. Base para melhoria contínua de UX/UI: o quê e onde, nunca
 * conteúdo financeiro nem clique a clique.
 * ------------------------------------------------------------------ */
export const usageEventKindEnum = pgEnum('usage_event_kind', ['view', 'action', 'error'])

export const usageEvents = pgTable(
  'usage_events',
  {
    id: id(),
    occurredAt: text('occurred_at').notNull().default(now),
    /** id aleatório gerado no navegador (localStorage), não é identidade de usuário — só agrupa eventos da mesma aba/sessão. */
    sessionId: text('session_id').notNull(),
    /** página/área do app, ex. "dashboard", "pricing", "transactions" */
    feature: text('feature').notNull(),
    kind: usageEventKindEnum('kind').notNull(),
    /** rótulo específico do evento, ex. "quote_created", "csv_commit", "validation_error" */
    name: text('name').notNull(),
    detail: jsonb('detail'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('usage_events_feature_idx').on(t.feature),
    index('usage_events_occurred_at_idx').on(t.occurredAt),
    index('usage_events_kind_idx').on(t.kind),
  ],
)
