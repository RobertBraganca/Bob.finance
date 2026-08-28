/**
 * Applies the person-specific rules in data/regras-locais.json.
 *
 * These live outside the seed on purpose. The seed carries patterns any
 * Brazilian account would have (iFood, Enel, DAS); this file carries THIS
 * person's clients and payees, inferred from their own statements. Keeping
 * them apart means the seed stays reusable and these stay editable without
 * touching code.
 *
 * Run: npm run regras:locais
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '../server/src/db/client'
import { categoryRules } from '../server/src/db/schema'
import { categoryOptions } from '../server/src/services/categories'
import { recategorize } from '../server/src/services/categorization'

type LocalRule = {
  pattern: string
  direction?: 'in' | 'out' | 'any'
  categoria?: string
  prioridade?: number
  evidencia?: string
}

const FILE = resolve(process.argv[2] ?? 'data/regras-locais.json')
if (!existsSync(FILE)) {
  console.error(`arquivo não encontrado: ${FILE}`)
  process.exit(1)
}

const config = JSON.parse(readFileSync(FILE, 'utf8')) as {
  aplicar?: LocalRule[]
  revisar?: LocalRule[]
}

const byPath = new Map(categoryOptions().map((option) => [option.path, option.id] as const))

let created = 0
let updated = 0
const problems: string[] = []

for (const rule of config.aplicar ?? []) {
  if (!rule.categoria) {
    problems.push(`"${rule.pattern}" está em 'aplicar' sem categoria — ignorada`)
    continue
  }
  const categoryId = byPath.get(rule.categoria)
  if (categoryId === undefined) {
    problems.push(`categoria inexistente para "${rule.pattern}": ${rule.categoria}`)
    continue
  }

  const pattern = rule.pattern.trim().toLowerCase()
  const direction = rule.direction ?? 'any'

  const existing = db
    .select()
    .from(categoryRules)
    .where(
      and(
        eq(categoryRules.field, 'description'),
        eq(categoryRules.matchType, 'contains'),
        eq(categoryRules.pattern, pattern),
        eq(categoryRules.direction, direction),
      ),
    )
    .get()

  if (existing) {
    if (existing.categoryId !== categoryId) {
      db.update(categoryRules)
        .set({ categoryId, active: true })
        .where(eq(categoryRules.id, existing.id))
        .run()
      updated++
    }
    continue
  }

  db.insert(categoryRules)
    .values({
      categoryId,
      field: 'description',
      matchType: 'contains',
      pattern,
      direction,
      priority: rule.prioridade ?? 40,
      origin: 'user',
    })
    .run()
  created++
  console.log(
    `  + ${pattern.padEnd(32)} ${direction.padEnd(4)} -> ${rule.categoria}` +
      (rule.evidencia ? `\n      ${rule.evidencia}` : ''),
  )
}

console.log(`\n${created} regras criadas, ${updated} realinhadas`)
for (const problem of problems) console.log(`  ! ${problem}`)

const pending = (config.revisar ?? []).filter((r) => !r.categoria)
if (pending.length > 0) {
  console.log(`\n--- ${pending.length} contrapartes aguardando sua classificação ---`)
  for (const rule of pending) {
    console.log(`  ${rule.pattern.padEnd(32)} ${rule.evidencia ?? ''}`)
  }
  console.log(`\n  Preencha "categoria" em ${FILE}, mova para "aplicar" e rode de novo.`)
}

console.log('\n--- recategorizando ---')
console.log(recategorize({ onlyUncategorized: true }))
