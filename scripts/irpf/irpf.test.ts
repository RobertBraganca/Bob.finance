import assert from 'node:assert/strict'
import { test } from 'node:test'
import { effectiveIrpfGroup, inferIrpfGroup } from '../../server/src/core/irpf'

/** Dedução no IRPF pelo nome da categoria (decisions/0047), com os nomes reais do app. */
test('inferência: deduz só o que a Receita aceita, pela folha', () => {
  const cases: Array<[string, string | null, string | null]> = [
    ['Consultas e exames', 'Saúde', 'health'],
    ['Plano de saúde', 'Saúde', 'health'],
    ['Farmácia', 'Saúde', null],
    ['Academia', 'Saúde', null],
    ['Plano de saúde pet', 'Pets', null],
    ['Vet', 'Pets', null],
    ['Mensalidade', 'Educação', 'education'],
    ['Cursos', 'Educação', null],
    ['Livros', 'Educação', null],
    ['Graduação', 'Desenvolvimento Pessoal', 'education'],
    ['Especialização', 'Desenvolvimento Pessoal', 'education'],
    ['Mensalidade', 'Academia', null],
    ['Aluguel', 'Moradia', null],
    ['Previdência PGBL', 'Investimentos e Metas', 'pension'],
    ['Pensão alimentícia', null, 'alimony'],
    ['Saúde', null, null],
  ]
  for (const [name, parent, expected] of cases) assert.equal(inferIrpfGroup(name, parent), expected, `${parent ?? ''} > ${name}`)
})

test('o gravado vence o nome; none diz que não deduz; a mãe vale para a filha', () => {
  assert.deepEqual(effectiveIrpfGroup({ name: 'Farmácia', irpfGroup: 'health' }, { name: 'Saúde', irpfGroup: null }), { group: 'health', source: 'manual' })
  assert.deepEqual(effectiveIrpfGroup({ name: 'Plano de saúde', irpfGroup: 'none' }, { name: 'Saúde', irpfGroup: null }), { group: null, source: 'manual' })
  assert.deepEqual(effectiveIrpfGroup({ name: 'Terapia do casal', irpfGroup: null }, { name: 'Com ela', irpfGroup: 'none' }), { group: null, source: 'manual' })
  assert.deepEqual(effectiveIrpfGroup({ name: 'Consultas e exames', irpfGroup: null }, { name: 'Saúde', irpfGroup: null }), { group: 'health', source: 'auto' })
})
