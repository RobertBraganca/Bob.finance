/**
 * Adds the category tree from the user's reference screenshots (another
 * app's Despesas/Receitas lists) alongside what already exists here —
 * additive only, per the user's explicit choice: nothing already
 * categorized gets remapped, and any name that already exists as a
 * sibling is skipped rather than duplicated.
 *
 * Run: npm run categorias:mobills
 */
import { db } from '../server/src/db/client'
import { categories } from '../server/src/db/schema'
import { createCategory } from '../server/src/services/categories'

const BOB_BLUE = '#007bff'
const BOB_PINK = '#ff2ea6'
const BOB_GREEN = '#1e8e3c'
const BOB_PURPLE = '#ba2be2'

type Node = { name: string; kind: 'income' | 'expense'; color: string; icon: string; children: string[] }

const TREE: Node[] = [
  {
    name: 'Pets',
    kind: 'expense',
    color: BOB_BLUE,
    icon: 'sparkle',
    children: ['Areia e ração dos gatos', 'Brinquedos para os gatos', 'Plano de saúde pet'],
  },
  {
    name: 'Desenvolvimento Pessoal',
    kind: 'expense',
    color: BOB_BLUE,
    icon: 'book-open',
    children: ['Comissão parceiros', 'Especialização', 'Eventos', 'Graduação'],
  },
  {
    name: 'Metas',
    kind: 'expense',
    color: BOB_PURPLE,
    icon: 'target',
    children: ['Compras para a casa', 'Viagens'],
  },
  {
    name: 'Profissional',
    kind: 'expense',
    color: BOB_PURPLE,
    icon: 'briefcase',
    children: ['Equipamentos', 'Impostos', 'Plataformas', 'Softwares'],
  },
  {
    name: 'Supermercado',
    kind: 'expense',
    color: BOB_GREEN,
    icon: 'tag',
    children: ['Compra do mês', 'Compras avulsas'],
  },
  {
    name: 'Assinaturas',
    kind: 'expense',
    color: BOB_BLUE,
    icon: 'refresh',
    children: ['Anuais', 'Mensais'],
  },
  {
    name: 'Investimentos e Metas',
    kind: 'expense',
    color: BOB_GREEN,
    icon: 'trending',
    children: [
      'Compras para a casa (investimento)',
      'Criptos (aporte)',
      'Equipamento (investimento)',
      'Negócios (investimento)',
      'Renda variável, fixa, FIIs e tesouro',
      'Reserva de casal',
      'Reserva de emergência (aporte)',
    ],
  },
  {
    name: 'Com ela',
    kind: 'expense',
    color: BOB_PINK,
    icon: 'sparkle',
    children: ['Presentes', 'Restaurante'],
  },
  {
    name: 'Receitas de Trabalho',
    kind: 'income',
    color: BOB_BLUE,
    icon: 'briefcase',
    children: [
      'Adiantamento',
      'Bonificações',
      'Bônus / PLR',
      'Comissões',
      'Indique e Ganhe',
      'Plataformas remuneradas (MRR)',
      'Prêmios',
      'Receita de Projetos Pontuais / Clientes',
      'Receita de Projetos Recorrentes / Clientes',
      'Salário / Pró-labore',
      'Ticket',
      'Vendas / Projetos',
    ],
  },
  {
    name: 'Receitas de Investimentos',
    kind: 'income',
    color: BOB_GREEN,
    icon: 'trending',
    children: ['Dividendos', 'Equity', 'JCP (Juros sobre Capital Próprio)', 'Participação em Empresas', 'Rendimentos (CDI, Tesouro, etc.)'],
  },
  {
    name: 'Outras Entradas',
    kind: 'income',
    color: BOB_PURPLE,
    icon: 'sparkle',
    children: [
      'Cashback',
      'Estorno / Devolução',
      'Presentes (Dinheiro)',
      'Reembolsos',
      'Renda Extra',
    ],
  },
]

let createdParents = 0
let createdChildren = 0
let skipped = 0

for (const node of TREE) {
  const topLevel = db.select().from(categories).all().filter((c) => c.parentId === null)
  let parent = topLevel.find((c) => c.name === node.name)

  if (!parent) {
    parent = createCategory({ name: node.name, kind: node.kind, color: node.color, icon: node.icon })
    createdParents++
  } else {
    skipped++
  }

  const siblings = db.select().from(categories).all().filter((c) => c.parentId === parent!.id)
  for (const childName of node.children) {
    if (siblings.some((s) => s.name === childName)) {
      skipped++
      continue
    }
    createCategory({ name: childName, parentId: parent.id })
    createdChildren++
  }
}

console.log(`${createdParents} categoria(s)-pai criada(s), ${createdChildren} subcategoria(s) criada(s), ${skipped} já existiam (puladas).`)
