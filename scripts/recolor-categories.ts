/**
 * Recolors the categories already sitting in the working database to the
 * BOB.OS brand palette introduced 2026-08-20.
 *
 * This is plain DML (UPDATE ... WHERE name = ...) against existing rows —
 * deliberately NOT a schema migration. Changing a column's declared
 * DEFAULT on `categories` forces drizzle-kit's SQLite dialect to rebuild
 * the whole table (create/copy/drop/rename), and that DROP TABLE fails
 * against a table other tables reference by foreign key, even under
 * `PRAGMA foreign_keys=OFF` (SQLite no-ops that pragma inside a
 * transaction). See the seed's TREE array for where these same colours
 * are assigned to freshly-seeded categories.
 *
 * Safe to re-run. Only touches the `color` column; never touches rows by
 * id, only by name, so it works whether this is the real ledger or a
 * fresh seed.
 *
 * Run: npx tsx scripts/recolor-categories.ts
 */
import { eq, isNull } from 'drizzle-orm'
import { db } from '../server/src/db/client'
import { categories } from '../server/src/db/schema'

const BOB_BLUE = '#007bff'
const BOB_PINK = '#ff2ea6'
const BOB_GREEN = '#1e8e3c'
const BOB_PURPLE = '#ba2be2'
const NEUTRAL = '#71717a'

/** Must match server/src/db/seed.ts's TREE exactly. */
const PARENT_COLOR: Record<string, string> = {
  Receitas: BOB_BLUE,
  Moradia: BOB_PINK,
  Alimentação: BOB_GREEN,
  Transporte: BOB_PURPLE,
  Saúde: BOB_BLUE,
  Pessoal: BOB_PINK,
  Negócio: BOB_GREEN,
  Educação: BOB_PURPLE,
  Financeiro: BOB_BLUE,
  Transferências: NEUTRAL,
  Investimentos: BOB_PURPLE,
}

let updatedParents = 0
let updatedChildren = 0

db.transaction((tx) => {
  const parents = tx.select().from(categories).where(isNull(categories.parentId)).all()

  for (const parent of parents) {
    const color = PARENT_COLOR[parent.name]
    if (!color) {
      console.warn(`[recolor] categoria-mãe sem mapeamento, ignorada: "${parent.name}"`)
      continue
    }

    if (parent.color !== color) {
      tx.update(categories).set({ color }).where(eq(categories.id, parent.id)).run()
      updatedParents++
    }

    // Children inherit the parent's hue — same rule seedCategories() and
    // updateCategory() already enforce for newly created/edited categories.
    const result = tx
      .update(categories)
      .set({ color })
      .where(eq(categories.parentId, parent.id))
      .run()
    updatedChildren += result.changes
  }
})

console.log(`[recolor] ${updatedParents} categoria(s)-mãe atualizadas`)
console.log(`[recolor] ${updatedChildren} subcategoria(s) atualizadas (sempre, para herdar a cor da mãe)`)

const remaining = db
  .select({ name: categories.name, color: categories.color })
  .from(categories)
  .where(isNull(categories.parentId))
  .all()
  .filter((c) => !Object.values(PARENT_COLOR).includes(c.color))
if (remaining.length > 0) {
  console.log('[recolor] categorias-mãe com cor fora da paleta da marca:')
  for (const r of remaining) console.log(`  ${r.name} -> ${r.color}`)
}
