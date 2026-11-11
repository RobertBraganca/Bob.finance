/**
 * Despesas dedutíveis no IRPF (pessoa física), decisions/0047: o DRE passa a
 * dizer o que do gasto pessoal abate no Imposto de Renda.
 *
 * Cada categoria tem um grupo de dedução. Quem decide, em ordem:
 *  1. o grupo gravado na própria categoria (`irpf_group`, inclusive `none`);
 *  2. o grupo gravado na categoria-mãe;
 *  3. o nome da categoria (e da mãe), pelas regras abaixo.
 * A inferência é pela folha, não pela mãe: "Saúde" mistura o que deduz
 * (consulta, plano) com o que não deduz (farmácia, academia).
 *
 * Regras da Receita usadas aqui (declaração completa):
 *  - saúde: médicos, dentistas, psicólogos, fisioterapeutas, fonoaudiólogos,
 *    terapeutas ocupacionais, hospitais, exames e planos de saúde, sem limite;
 *    remédio de farmácia e academia não deduzem;
 *  - educação: ensino infantil, fundamental, médio, técnico, graduação e
 *    pós-graduação, com limite anual por pessoa; curso livre, idioma e livro não;
 *  - previdência privada PGBL (e a oficial complementar): até 12% da renda
 *    tributável; VGBL não deduz;
 *  - pensão alimentícia judicial ou por escritura, sem limite.
 */
export const IRPF_GROUPS = ['health', 'education', 'pension', 'alimony'] as const
export type IrpfGroup = (typeof IRPF_GROUPS)[number]
/** o que a categoria pode gravar: um grupo, ou `none` para dizer "não deduz" */
export type IrpfGroupSetting = IrpfGroup | 'none'

export const IRPF_GROUP_LABEL: Record<IrpfGroup, string> = {
  health: 'Saúde',
  education: 'Educação',
  pension: 'Previdência (PGBL)',
  alimony: 'Pensão alimentícia',
}

/** Limite anual de educação por pessoa (declaração de 2025, ano-base 2024; o valor não muda desde 2015). */
export const EDUCATION_CAP_CENTS = 356_150
/** PGBL: até 12% da renda tributável. */
export const PENSION_CAP_BPS = 1_200

const NORMALIZE = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')

const NOT_DEDUCTIBLE = /farmacia|remedio|medicamento|academia|pet|vet|racao|curso livre|idioma|ingles|livro|material/
const RULES: Array<[IrpfGroup, RegExp]> = [
  ['health', /consulta|exame|plano de saude|dentist|odonto|psicolog|terapia|terapeut|fisioter|fonoaud|hospital|clinica|medic|laboratori|internac|cirurgi/],
  ['education', /mensalidade|escola|colegio|faculdade|graduacao|pos-?graduacao|especializacao|mestrado|doutorado|ensino|creche/],
  ['pension', /pgbl|previdencia/],
  ['alimony', /pensao aliment/],
]

/** O grupo que o nome sugere, ou null. `parentName` só desempata (ex.: "Mensalidade" sob "Academia" não é escola). */
export function inferIrpfGroup(name: string, parentName?: string | null): IrpfGroup | null {
  const own = NORMALIZE(name)
  const parent = parentName ? NORMALIZE(parentName) : ''
  if (NOT_DEDUCTIBLE.test(own) || /pet|vet/.test(parent)) return null
  for (const [group, pattern] of RULES) {
    if (pattern.test(own)) {
      // "Mensalidade" só é educação quando a mãe é de estudo.
      if (group === 'education' && /mensalidade/.test(own) && parent && !/educa|estudo|escola|desenvolvimento|faculdade/.test(parent)) return null
      return group
    }
  }
  return null
}

/** Grupo efetivo de uma categoria: o gravado nela, o da mãe, ou o do nome. */
export function effectiveIrpfGroup(
  own: { name: string; irpfGroup: string | null },
  parent: { name: string; irpfGroup: string | null } | null,
): { group: IrpfGroup | null; source: 'manual' | 'auto' } {
  const pick = (value: string | null) => (value === 'none' ? null : (value as IrpfGroup))
  if (own.irpfGroup) return { group: pick(own.irpfGroup), source: 'manual' }
  if (parent?.irpfGroup) return { group: pick(parent.irpfGroup), source: 'manual' }
  return { group: inferIrpfGroup(own.name, parent?.name ?? null), source: 'auto' }
}
