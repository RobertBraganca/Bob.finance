import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from './client'
import { isEntryPoint } from './migrate'
import {
  accounts,
  categories,
  categoryRules,
  criteria,
  parserProfiles,
  pricingMultiplierOptions,
} from './schema'

/**
 * Idempotent seed: default accounts, the Brazilian bank parser profiles, the
 * category tree, and a starter rule set so auto-categorization works on the
 * very first import. Safe to re-run.
 */

/* ---------------------------------------------------------------- *
 * Accounts
 * ---------------------------------------------------------------- */
const ACCOUNTS = [
  { name: 'Conta Corrente', institution: 'Itaú', kind: 'checking' },
  { name: 'Conta Nubank', institution: 'Nubank', kind: 'checking' },
  { name: 'Cartão de Crédito Nubank', institution: 'Nubank', kind: 'credit_card' },
  { name: 'Conta PJ', institution: 'Inter', kind: 'checking' },
  { name: 'Corretora', institution: 'Clear', kind: 'investment' },
] as const

/* ---------------------------------------------------------------- *
 * Category tree. Parent colors come from the validated categorical
 * palette; children inherit their parent's hue, because the ring chart
 * groups by parent and children never compete for a slot.
 * ---------------------------------------------------------------- */
type Node = { name: string; children: string[] }

/**
 * Brand-safe categorical set: BOB.OS's own secondary colours (blue, pink,
 * green, purple) — the only 4 the identity provides outside red/yellow,
 * which are reserved for status. Cycled across the parent groups below;
 * a swatch is never the ONLY way to tell two categories apart (name +
 * icon + kind-group heading always travel with it), so reusing a hue
 * across non-adjacent groups is fine — it is only the ring chart's own
 * top-4 that has the strict adjacent-pair guarantee, via its own fold.
 */
const BOB_BLUE = '#007bff'
const BOB_PINK = '#ff2ea6'
const BOB_GREEN = '#1e8e3c'
const BOB_PURPLE = '#ba2be2'

const TREE: Array<{ kind: string; color: string; icon: string; node: Node }> = [
  {
    kind: 'income',
    color: BOB_BLUE,
    icon: 'arrow-down-left',
    node: {
      name: 'Receitas',
      children: [
        'Salário',
        'Pró-labore',
        'Freelance / PJ',
        'Aluguéis',
        'Rendimentos',
        'Reembolsos',
        'Outras receitas',
      ],
    },
  },
  {
    kind: 'expense',
    color: BOB_PINK,
    icon: 'home',
    node: {
      name: 'Moradia',
      children: ['Aluguel', 'Condomínio', 'Energia', 'Água', 'Gás', 'Internet', 'IPTU', 'Manutenção casa'],
    },
  },
  {
    kind: 'expense',
    color: BOB_GREEN,
    icon: 'utensils',
    node: {
      name: 'Alimentação',
      children: ['Supermercado', 'Restaurante', 'Delivery', 'Padaria e café'],
    },
  },
  {
    kind: 'expense',
    color: BOB_PURPLE,
    icon: 'car',
    node: {
      name: 'Transporte',
      children: [
        'Combustível',
        'App de transporte',
        'Estacionamento',
        'Transporte público',
        'Manutenção veículo',
        'IPVA e licenciamento',
      ],
    },
  },
  {
    kind: 'expense',
    color: BOB_BLUE,
    icon: 'heart-pulse',
    node: {
      name: 'Saúde',
      children: ['Plano de saúde', 'Farmácia', 'Consultas e exames', 'Academia'],
    },
  },
  {
    kind: 'expense',
    color: BOB_PINK,
    icon: 'user',
    node: {
      name: 'Pessoal',
      children: ['Vestuário', 'Beleza', 'Assinaturas', 'Lazer', 'Presentes'],
    },
  },
  {
    kind: 'expense',
    color: BOB_GREEN,
    icon: 'briefcase',
    node: {
      name: 'Negócio',
      children: [
        'Ferramentas e SaaS',
        'Serviços terceirizados',
        'Impostos',
        'Marketing',
        'Escritório',
      ],
    },
  },
  {
    kind: 'expense',
    color: BOB_PURPLE,
    icon: 'book-open',
    node: { name: 'Educação', children: ['Cursos', 'Mensalidade', 'Livros'] },
  },
  {
    kind: 'expense',
    color: BOB_BLUE,
    icon: 'landmark',
    node: {
      name: 'Financeiro',
      children: ['Juros e multas', 'Tarifas bancárias', 'Empréstimos', 'Seguros'],
    },
  },
  // Card-bill payments and account-to-account moves are TRANSFERS, not
  // expenses. Counting them as spending would double-count every card
  // purchase: once when it posts on the card, again when the bill is paid.
  {
    kind: 'transfer',
    color: '#71717a',
    icon: 'arrow-left-right',
    node: {
      name: 'Transferências',
      children: ['Entre contas próprias', 'Pagamento de cartão', 'Terceiros'],
    },
  },
  {
    kind: 'investment',
    color: BOB_PURPLE,
    icon: 'trending-up',
    node: { name: 'Investimentos', children: ['Aportes', 'Resgates', 'Proventos'] },
  },
]

/* ---------------------------------------------------------------- *
 * Parser profiles — one row per bank dialect. Between them they cover
 * all four sign conventions the pipeline supports.
 * ---------------------------------------------------------------- */
const PROFILES = [
  {
    name: 'Nubank Conta',
    institution: 'Nubank',
    delimiter: ',',
    encoding: 'utf-8',
    dateFormat: 'dd/MM/yyyy',
    decimalSeparator: '.',
    thousandsSeparator: '',
    signConvention: 'signed',
    hasHeader: true,
    skipRows: 0,
    columnMap: { date: 'Data', description: 'Descrição', amount: 'Valor' },
    headerSignature: ['Data', 'Valor', 'Identificador', 'Descrição'],
    ignorePatterns: [],
  },
  {
    name: 'Nubank Cartão de Crédito',
    institution: 'Nubank',
    delimiter: ',',
    encoding: 'utf-8',
    dateFormat: 'yyyy-MM-dd',
    decimalSeparator: '.',
    thousandsSeparator: '',
    // On a card statement a positive number is a purchase, i.e. money out.
    signConvention: 'signed_inverted',
    hasHeader: true,
    skipRows: 0,
    columnMap: { date: 'date', description: 'title', amount: 'amount' },
    headerSignature: ['date', 'title', 'amount'],
    ignorePatterns: ['pagamento recebido'],
  },
  {
    name: 'Itaú Extrato',
    institution: 'Itaú',
    delimiter: ';',
    encoding: 'latin1',
    dateFormat: 'dd/MM/yyyy',
    decimalSeparator: ',',
    thousandsSeparator: '.',
    signConvention: 'signed',
    hasHeader: true,
    skipRows: 0,
    columnMap: { date: 'data', description: 'lancamento', amount: 'valor' },
    headerSignature: ['data', 'lancamento', 'valor', 'saldo'],
    ignorePatterns: ['saldo anterior', 'saldo do dia', 'saldo final', 'total'],
  },
  {
    name: 'Bradesco Extrato',
    institution: 'Bradesco',
    delimiter: ';',
    encoding: 'latin1',
    dateFormat: 'dd/MM/yyyy',
    decimalSeparator: ',',
    thousandsSeparator: '.',
    signConvention: 'debit_credit',
    hasHeader: true,
    skipRows: 0,
    columnMap: {
      date: 'Data',
      description: 'Histórico',
      debit: 'Débito',
      credit: 'Crédito',
      docNumber: 'Docto',
    },
    headerSignature: ['Data', 'Histórico', 'Crédito', 'Débito', 'Saldo'],
    ignorePatterns: ['saldo anterior', 'saldo total disponivel', 'total'],
  },
  {
    name: 'Santander Extrato',
    institution: 'Santander',
    delimiter: ';',
    encoding: 'latin1',
    dateFormat: 'dd/MM/yyyy',
    decimalSeparator: ',',
    thousandsSeparator: '.',
    signConvention: 'type_flag',
    hasHeader: true,
    skipRows: 0,
    columnMap: {
      date: 'Data',
      description: 'Historico',
      amount: 'Valor',
      typeFlag: 'Tipo',
      docNumber: 'Documento',
    },
    headerSignature: ['Data', 'Historico', 'Documento', 'Valor', 'Tipo'],
    ignorePatterns: ['saldo anterior', 'saldo em conta'],
  },
  {
    name: 'Banco Inter Extrato',
    institution: 'Inter',
    delimiter: ';',
    encoding: 'utf-8',
    dateFormat: 'dd/MM/yyyy',
    decimalSeparator: ',',
    thousandsSeparator: '.',
    signConvention: 'signed',
    hasHeader: true,
    // The real Inter export opens with five preamble lines (título, conta,
    // período, saldo, linha vazia) before the header row.
    skipRows: 5,
    columnMap: {
      date: 'Data Lançamento',
      description: 'Descrição',
      amount: 'Valor',
    },
    headerSignature: ['Data Lançamento', 'Descrição', 'Valor', 'Saldo'],
    ignorePatterns: ['saldo do dia', 'saldo anterior'],
  },
  {
    // PicPay exports a paginated PDF-style report, not a table. It is
    // pre-normalized by scripts/normalize-picpay.ts into this shape so the
    // generic pipeline can read it without any PicPay-specific branch.
    name: 'PicPay Relatório normalizado',
    institution: 'PicPay',
    delimiter: ';',
    encoding: 'utf-8',
    dateFormat: 'dd/MM/yyyy',
    decimalSeparator: ',',
    thousandsSeparator: '.',
    signConvention: 'signed',
    hasHeader: true,
    skipRows: 0,
    columnMap: { date: 'Data', description: 'Descrição', amount: 'Valor' },
    headerSignature: ['Data', 'Descrição', 'Valor', 'Movimentacao'],
    ignorePatterns: [],
  },
] as const

/* ---------------------------------------------------------------- *
 * Starter rules — high-confidence Brazilian merchant patterns.
 * ---------------------------------------------------------------- */
const RULES: Array<[string, string, number?]> = [
  ['ifood', 'Alimentação/Delivery'],
  ['rappi', 'Alimentação/Delivery'],
  ['zedelivery', 'Alimentação/Delivery'],
  ['carrefour', 'Alimentação/Supermercado'],
  ['pao de acucar', 'Alimentação/Supermercado'],
  ['assai', 'Alimentação/Supermercado'],
  ['atacadao', 'Alimentação/Supermercado'],
  ['supermercado', 'Alimentação/Supermercado', 120],
  ['mercado', 'Alimentação/Supermercado', 140],
  ['padaria', 'Alimentação/Padaria e café'],
  ['starbucks', 'Alimentação/Padaria e café'],
  ['restaurante', 'Alimentação/Restaurante', 130],
  ['outback', 'Alimentação/Restaurante'],
  ['uber trip', 'Transporte/App de transporte', 80],
  ['uber', 'Transporte/App de transporte', 120],
  ['99app', 'Transporte/App de transporte'],
  ['cabify', 'Transporte/App de transporte'],
  ['posto', 'Transporte/Combustível'],
  ['shell', 'Transporte/Combustível'],
  ['ipiranga', 'Transporte/Combustível'],
  ['estapar', 'Transporte/Estacionamento'],
  ['netflix', 'Pessoal/Assinaturas'],
  ['spotify', 'Pessoal/Assinaturas'],
  ['disney plus', 'Pessoal/Assinaturas'],
  ['amazon prime', 'Pessoal/Assinaturas'],
  ['drogasil', 'Saúde/Farmácia'],
  ['droga raia', 'Saúde/Farmácia'],
  ['drogaria', 'Saúde/Farmácia'],
  ['pacheco', 'Saúde/Farmácia'],
  ['unimed', 'Saúde/Plano de saúde'],
  ['sulamerica', 'Saúde/Plano de saúde'],
  ['amil', 'Saúde/Plano de saúde'],
  ['smart fit', 'Saúde/Academia'],
  ['enel', 'Moradia/Energia'],
  ['cemig', 'Moradia/Energia'],
  ['light servicos', 'Moradia/Energia'],
  ['sabesp', 'Moradia/Água'],
  ['copasa', 'Moradia/Água'],
  ['comgas', 'Moradia/Gás'],
  ['vivo fibra', 'Moradia/Internet'],
  ['claro', 'Moradia/Internet'],
  ['iptu', 'Moradia/IPTU'],
  ['aluguel', 'Moradia/Aluguel'],
  ['condominio', 'Moradia/Condomínio'],
  ['figma', 'Negócio/Ferramentas e SaaS'],
  ['adobe', 'Negócio/Ferramentas e SaaS'],
  ['notion', 'Negócio/Ferramentas e SaaS'],
  ['vercel', 'Negócio/Ferramentas e SaaS'],
  ['google cloud', 'Negócio/Ferramentas e SaaS'],
  ['aws', 'Negócio/Ferramentas e SaaS'],
  ['anthropic', 'Negócio/Ferramentas e SaaS'],
  ['openai', 'Negócio/Ferramentas e SaaS'],
  ['das simples nacional', 'Negócio/Impostos'],
  ['darf', 'Negócio/Impostos'],
  ['servicos terceirizados', 'Negócio/Serviços terceirizados'],
  ['coworking', 'Negócio/Escritório'],
  ['meta platforms', 'Negócio/Marketing'],
  ['google ads', 'Negócio/Marketing'],
  ['curso', 'Educação/Cursos', 150],
  ['seguro', 'Financeiro/Seguros', 150],
  ['tarifa', 'Financeiro/Tarifas bancárias'],
  ['anuidade', 'Financeiro/Tarifas bancárias'],
  ['juros', 'Financeiro/Juros e multas'],
  ['multa', 'Financeiro/Juros e multas'],
  ['pagamento de fatura', 'Transferências/Pagamento de cartão'],
  ['pagamento fatura', 'Transferências/Pagamento de cartão'],
  ['salario', 'Receitas/Salário'],
  ['pro labore', 'Receitas/Pró-labore'],
  ['prolabore', 'Receitas/Pró-labore'],
  ['rendimento', 'Receitas/Rendimentos'],
  ['recebimento cliente', 'Receitas/Freelance / PJ'],
  ['recebido cliente', 'Receitas/Freelance / PJ'],
  ['reembolso', 'Receitas/Reembolsos'],
  // "Resgate de empréstimo" is loan money, not an investment redemption —
  // it has to outrank the broad "resgate" pattern below.
  ['resgate de emprestimo', 'Financeiro/Empréstimos', 60],
  ['aplicacao', 'Investimentos/Aportes'],
  ['resgate', 'Investimentos/Resgates'],
  ['transferencia entre contas', 'Transferências/Entre contas próprias'],

  /* ---- PicPay: mecânica da carteira -----------------------------
   * Estes são rótulos fixos do PicPay, não comerciantes. Recarregar a
   * carteira, sacar o lastro e pagar a fatura do PicPay Card são
   * movimentações INTERNAS: tratá-las como despesa infla os dois lados
   * do painel, porque o gasto real já aparece quando a compra posta. */
  /* ---- Nubank: mecânica da conta e do cartão -------------------- */
  ['pagamento da fatura', 'Transferências/Pagamento de cartão', 70],
  ['fatura cartao', 'Transferências/Pagamento de cartão', 75],
  ['valor adicionado na conta por cartao de credito', 'Transferências/Entre contas próprias', 70],
  ['compra de criptomoedas', 'Investimentos/Aportes', 70],
  ['venda de criptomoedas', 'Investimentos/Resgates', 70],
  ['recarga de cartao de transporte', 'Transporte/Transporte público', 70],

  /* ---- comércio brasileiro de rua, comum em compra no débito ---- */
  ['lanchonete', 'Alimentação/Restaurante'],
  ['pizzaria', 'Alimentação/Restaurante'],
  ['churrascaria', 'Alimentação/Restaurante'],
  ['boulangerie', 'Alimentação/Padaria e café'],
  ['confeitaria', 'Alimentação/Padaria e café'],
  ['cafeteria', 'Alimentação/Padaria e café'],
  ['hortifruti', 'Alimentação/Supermercado'],
  ['acougue', 'Alimentação/Supermercado'],
  ['emporio', 'Alimentação/Supermercado'],
  ['farmacia', 'Saúde/Farmácia'],
  ['barbearia', 'Pessoal/Beleza'],
  ['salao de beleza', 'Pessoal/Beleza'],

  ['recarga em carteira', 'Transferências/Entre contas próprias', 70],
  ['estorno de recarga', 'Transferências/Entre contas próprias', 70],
  ['retirada de saldo por lastro', 'Transferências/Entre contas próprias', 70],
  ['pagamento de fatura picpay', 'Transferências/Pagamento de cartão', 70],
  ['pagamento da fatura picpay', 'Transferências/Pagamento de cartão', 70],
  ['aporte na carteira cofrinho', 'Investimentos/Aportes', 70],
  ['resgate na carteira cofrinho', 'Investimentos/Resgates', 70],
  ['cashback', 'Receitas/Outras receitas'],
  ['emprestimo', 'Financeiro/Empréstimos', 140],
  ['transferencia realizada - ted', 'Transferências/Terceiros'],
]

/**
 * Self-transfer detection.
 *
 * A Pix whose counterparty is the account holder themself is money moving
 * between their own accounts, not income or expense. Matching on the holder's
 * name is the only signal a bank export gives for this, and it matters a lot:
 * without it every internal top-up counts as revenue on one side and spending
 * on the other, and the whole dashboard becomes fiction.
 *
 * Deliberadamente NOT a blanket rule on "transferência recebida" — an incoming
 * Pix from a client is real revenue, and a broad rule there would erase it.
 * Anything this list does not match stays uncategorized for the user to
 * triage, which is the honest default.
 *
 * Set FINANCE_OWNER_NAMES (comma-separated) to match a different holder.
 */
const OWNER_NAMES = (
  process.env.FINANCE_OWNER_NAMES ?? 'robert da silva braganca,robert braganca,robert bragança'
)
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean)

const OWNER_RULES: Array<[string, string, number]> = OWNER_NAMES.map((name) => [
  name,
  'Transferências/Entre contas próprias',
  30,
])

/* ---------------------------------------------------------------- */

async function seedAccounts(): Promise<Map<string, number>> {
  const byName = new Map<string, number>()
  for (const account of ACCOUNTS) {
    const existing = (await db.select().from(accounts).where(eq(accounts.name, account.name)))[0]
    if (existing) {
      byName.set(account.name, existing.id)
      continue
    }
    const inserted = (
      await db
        .insert(accounts)
        .values({
          name: account.name,
          institution: account.institution,
          kind: account.kind as (typeof accounts.$inferInsert)['kind'],
        })
        .returning({ id: accounts.id })
    )[0]!
    byName.set(account.name, inserted.id)
  }
  return byName
}

async function seedCategories(): Promise<Map<string, number>> {
  const byPath = new Map<string, number>()

  for (const [parentIndex, entry] of TREE.entries()) {
    const parentRow =
      (await db.select().from(categories).where(and(isNull(categories.parentId), eq(categories.name, entry.node.name))))[0] ??
      (
        await db
          .insert(categories)
          .values({
            parentId: null,
            name: entry.node.name,
            kind: entry.kind as (typeof categories.$inferInsert)['kind'],
            color: entry.color,
            icon: entry.icon,
            sortOrder: parentIndex,
          })
          .returning()
      )[0]!

    byPath.set(entry.node.name, parentRow.id)

    for (const [childIndex, child] of entry.node.children.entries()) {
      const path = `${entry.node.name}/${child}`
      const childRow =
        (await db.select().from(categories).where(and(eq(categories.parentId, parentRow.id), eq(categories.name, child))))[0] ??
        (
          await db
            .insert(categories)
            .values({
              parentId: parentRow.id,
              name: child,
              kind: entry.kind as (typeof categories.$inferInsert)['kind'],
              color: entry.color,
              icon: entry.icon,
              sortOrder: childIndex,
            })
            .returning()
        )[0]!
      byPath.set(path, childRow.id)
    }
  }

  // "Reajuste de saldo" is a child of Financeiro (expense) but is itself
  // kind 'transfer': a balance correction is neither income nor expense,
  // same reasoning already applied to card-bill payments above (see
  // decisions/0018). Category rows don't inherit kind from their parent —
  // it's a per-row column — so this one explicit insert is enough, no
  // change to the TREE loop above.
  const financeiroId = byPath.get('Financeiro')
  if (financeiroId !== undefined) {
    const path = 'Financeiro/Reajuste de saldo'
    const existing = (
      await db
        .select()
        .from(categories)
        .where(and(eq(categories.parentId, financeiroId), eq(categories.name, 'Reajuste de saldo')))
    )[0]
    const row =
      existing ??
      (
        await db
          .insert(categories)
          .values({
            parentId: financeiroId,
            name: 'Reajuste de saldo',
            kind: 'transfer',
            color: BOB_BLUE,
            icon: 'landmark',
            sortOrder: 99,
          })
          .returning()
      )[0]!
    byPath.set(path, row.id)
  }

  return byPath
}

async function seedProfiles(accountsByName: Map<string, number>) {
  const defaultAccount: Record<string, string> = {
    'Nubank Conta': 'Conta Nubank',
    'Nubank Cartão de Crédito': 'Cartão de Crédito Nubank',
    'Itaú Extrato': 'Conta Corrente',
    'Banco Inter Extrato': 'Conta PJ',
    'Bradesco Extrato': 'Conta PJ',
    'Santander Extrato': 'Conta Corrente',
  }

  for (const profile of PROFILES) {
    const existing = (await db.select().from(parserProfiles).where(eq(parserProfiles.name, profile.name)))[0]
    if (existing) continue

    const accountName = defaultAccount[profile.name]
    await db.insert(parserProfiles).values({
      name: profile.name,
      institution: profile.institution,
      delimiter: profile.delimiter as (typeof parserProfiles.$inferInsert)['delimiter'],
      encoding: profile.encoding,
      dateFormat: profile.dateFormat as (typeof parserProfiles.$inferInsert)['dateFormat'],
      decimalSeparator: profile.decimalSeparator,
      thousandsSeparator: profile.thousandsSeparator,
      signConvention: profile.signConvention as (typeof parserProfiles.$inferInsert)['signConvention'],
      hasHeader: profile.hasHeader,
      skipRows: profile.skipRows,
      columnMap: profile.columnMap,
      headerSignature: profile.headerSignature,
      ignorePatterns: profile.ignorePatterns,
      defaultAccountId: accountName ? (accountsByName.get(accountName) ?? null) : null,
    })
  }
}

async function seedRules(categoriesByPath: Map<string, number>) {
  let created = 0
  let skipped = 0
  let realigned = 0

  for (const [pattern, path, priority] of [...OWNER_RULES, ...RULES]) {
    const categoryId = categoriesByPath.get(path)
    if (!categoryId) {
      console.warn(`[seed] regra ignorada, categoria inexistente: ${path}`)
      skipped++
      continue
    }
    const existing = (
      await db
        .select()
        .from(categoryRules)
        .where(and(eq(categoryRules.pattern, pattern), eq(categoryRules.field, 'description')))
    )[0]

    if (existing) {
      // Converge, don't skip. If a seeded rule's target category changed
      // between releases, a plain skip would leave the rule pointing at the
      // old category forever — which is how "pagamento de fatura" ended up
      // classified as an expense instead of a transfer, double-counting
      // every card purchase. User-authored rules are never touched.
      if (existing.origin === 'user' && existing.categoryId !== categoryId) {
        await db.update(categoryRules).set({ categoryId }).where(eq(categoryRules.id, existing.id))
        realigned++
      } else {
        skipped++
      }
      continue
    }
    await db.insert(categoryRules).values({
      categoryId,
      field: 'description',
      matchType: 'contains',
      pattern,
      direction: 'any',
      priority: priority ?? 100,
      origin: 'user',
    })
    created++
  }
  return { created, skipped, realigned }
}

/* ---------------------------------------------------------------- *
 * Resistance criteria ("Diagrama do Cerrado") — one question bank per
 * asset class. Straight from the questionnaire the strategy actually
 * uses: a stock's resilience questions are not a FII's, are not a
 * fixed-income asset's. Classes with no bank here (crypto, funds,
 * cash, pension, other) simply start empty — the user adds their own
 * from the UI, exactly as the source material invites ("podem ser
 * adicionadas novas perguntas").
 * ---------------------------------------------------------------- */
const CRITERIA_BANK: Record<string, string[]> = {
  stocks: [
    'Empresa com mais de 5 anos de bolsa',
    'Empresa nunca deu prejuízo (ano fiscal)',
    'Empresa com lucro nos últimos 20 trimestres (5 anos)',
    'Empresa pagou +5% de dividendos/ano nos últimos 5 anos',
    'Empresa possui ROE acima de 10%',
    'Dívida líquida menor que o patrimônio',
    'Empresa apresentou crescimento de receita nos últimos 5 anos',
    'Empresa apresentou crescimento de lucros nos últimos 5 anos',
    'Empresa possui liquidez diária acima de R$ 2 milhões',
    'Empresa é bem avaliada pelo mercado (P/L, P/VP razoáveis)',
    'Empresa com 100% de tag along',
    'Empresa pertence a um setor perene (não cíclico)',
  ],
  fii: [
    'FII com mais de 3 anos de mercado',
    'Vacância física menor que 10%',
    'Localização premium dos imóveis',
    'Gestão experiente e transparente',
    'P/VP entre 0,85 e 1,15',
    'Dividendos consistentes nos últimos 24 meses',
    'Liquidez diária acima de R$ 500 mil',
    'Diversificação adequada de inquilinos (multi-inquilino)',
    'Sem histórico de amortizações forçadas',
    'Taxa de administração razoável (< 1% ao ano)',
    'Pertence a segmento resiliente',
    'Contratos de longo prazo com reajuste por índice (IPCA+)',
  ],
  fixed_income: [
    'Rating de crédito AAA ou AA',
    'Emissor com histórico de solvência (sem defaults)',
    'Rentabilidade acima da Selic/CDI',
    'Liquidez ou vencimento compatível com o objetivo',
    'Garantias robustas (FGC, colateral)',
    'Emissor com balanço saudável',
    'Sem cláusulas de resgate antecipado prejudiciais',
    'Indexado a um índice confiável (IPCA, CDI, Selic)',
    'Duration compatível com o objetivo',
    'Emissor é instituição sólida ou o governo',
    'Tributação favorável (isenção de IR, se aplicável)',
    'Não concentra risco excessivo na carteira',
  ],
}

async function seedCriteria() {
  let created = 0
  for (const [assetClass, labels] of Object.entries(CRITERIA_BANK)) {
    for (const [sortOrder, label] of labels.entries()) {
      const existing = (
        await db
          .select()
          .from(criteria)
          .where(and(eq(criteria.assetClass, assetClass as (typeof criteria.$inferInsert)['assetClass']), eq(criteria.label, label)))
      )[0]
      if (existing) continue
      await db.insert(criteria).values({ assetClass: assetClass as (typeof criteria.$inferInsert)['assetClass'], label, sortOrder })
      created++
    }
  }
  return { created }
}

/* ---------------------------------------------------------------- *
 * Pricing multipliers — the same "bank of editable options" shape as
 * the criteria above. These are SUGGESTIONS carried over from the
 * Calculadora de Freelas (see `decisions/0012`), not fixed constants:
 * the user edits, deactivates or adds options per dimension, because
 * what counts as "complex" or "urgent" varies by trade.
 * ---------------------------------------------------------------- */
const MULTIPLIER_BANK: Record<string, Array<{ label: string; multiplierBps: number; description?: string }>> = {
  complexity: [
    { label: 'Simples', multiplierBps: 9_000, description: 'Escopo conhecido, pouca variável nova' },
    { label: 'Padrão', multiplierBps: 10_000, description: 'O trabalho típico da sua rotina' },
    { label: 'Complexo', multiplierBps: 13_000, description: 'Exige pesquisa, integração ou muitas revisões' },
    { label: 'Muito complexo', multiplierBps: 16_000, description: 'Escopo incerto ou tecnicamente exigente' },
  ],
  urgency: [
    { label: 'Sem urgência', multiplierBps: 9_500, description: 'Prazo folgado, encaixa entre outros trabalhos' },
    { label: 'Normal', multiplierBps: 10_000, description: 'Prazo combinado sem aperto' },
    { label: 'Urgente', multiplierBps: 13_000, description: 'Exige reorganizar a agenda' },
    { label: 'Crítico', multiplierBps: 17_000, description: 'Exige noite, fim de semana ou parar outro projeto' },
  ],
  client_size: [
    { label: 'Pessoa física / MEI', multiplierBps: 8_500 },
    { label: 'Pequena empresa', multiplierBps: 10_000 },
    { label: 'Empresa média', multiplierBps: 12_000 },
    { label: 'Grande empresa', multiplierBps: 15_000 },
    { label: 'Multinacional', multiplierBps: 20_000 },
  ],
  usage_rights: [
    { label: 'Uso pessoal / portfólio', multiplierBps: 10_000 },
    { label: 'Uso comercial limitado', multiplierBps: 11_500, description: 'Um canal, praça ou período definido' },
    { label: 'Uso comercial amplo', multiplierBps: 14_000, description: 'Vários canais, sem limite de praça' },
    { label: 'Exclusividade total', multiplierBps: 18_000, description: 'Cessão integral, sem uso pelo autor' },
  ],
}

async function seedPricingMultipliers() {
  let created = 0
  for (const [dimension, options] of Object.entries(MULTIPLIER_BANK)) {
    for (const [sortOrder, option] of options.entries()) {
      // Idempotent by (dimension, label), same as the criteria bank: a label
      // the user edited or removed is never resurrected on the next boot.
      const existing = (
        await db
          .select()
          .from(pricingMultiplierOptions)
          .where(
            and(
              eq(pricingMultiplierOptions.dimension, dimension as (typeof pricingMultiplierOptions.$inferInsert)['dimension']),
              eq(pricingMultiplierOptions.label, option.label),
            ),
          )
      )[0]
      if (existing) continue
      await db.insert(pricingMultiplierOptions).values({
        dimension: dimension as (typeof pricingMultiplierOptions.$inferInsert)['dimension'],
        label: option.label,
        description: option.description ?? null,
        multiplierBps: option.multiplierBps,
        sortOrder,
      })
      created++
    }
  }
  return { created }
}

export async function seed() {
  const accountsByName = await seedAccounts()
  const categoriesByPath = await seedCategories()
  await seedProfiles(accountsByName)
  const rules = await seedRules(categoriesByPath)
  const criteriaResult = await seedCriteria()
  const multipliersResult = await seedPricingMultipliers()

  const [accountsCount, categoriesCount, profilesCount, rulesCount, criteriaCount, multipliersCount] = await Promise.all([
    db.select({ n: sql<number>`count(*)` }).from(accounts),
    db.select({ n: sql<number>`count(*)` }).from(categories),
    db.select({ n: sql<number>`count(*)` }).from(parserProfiles),
    db.select({ n: sql<number>`count(*)` }).from(categoryRules),
    db.select({ n: sql<number>`count(*)` }).from(criteria),
    db.select({ n: sql<number>`count(*)` }).from(pricingMultiplierOptions),
  ])
  const counts = {
    accounts: accountsCount[0]?.n ?? 0,
    categories: categoriesCount[0]?.n ?? 0,
    profiles: profilesCount[0]?.n ?? 0,
    rules: rulesCount[0]?.n ?? 0,
    criteria: criteriaCount[0]?.n ?? 0,
    pricingMultipliers: multipliersCount[0]?.n ?? 0,
  }
  return {
    ...counts,
    rulesCreated: rules.created,
    rulesRealigned: rules.realigned,
    criteriaCreated: criteriaResult.created,
    pricingMultipliersCreated: multipliersResult.created,
  }
}

if (isEntryPoint('db/seed.ts')) {
  const result = await seed()
  console.log('[seed]', result)
}
