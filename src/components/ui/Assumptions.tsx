import { bps, money } from '../../lib/format'
import { Icon } from './Icon'

/**
 * "Como calculamos": the memory of calculation that every derived metric in
 * the intelligence layer carries.
 *
 * This is not a tooltip and not a nicety. `decisions/0010` makes it part of
 * the contract: an instrumental sentence without an auditable calculation
 * behind it does not satisfy the principle. The server already ships an
 * `assumptions` object next to every number it derives; this renders it,
 * whatever shape it has, so a new premise added on the server appears here
 * without a matching front-end change.
 *
 * Deliberately a `<details>` and not a modal: the number stays readable at a
 * glance, and the arithmetic is one click away on the same surface, never
 * behind a hover that a touch screen cannot reach.
 */

export type AssumptionValue = unknown
export type AssumptionBag = Record<string, AssumptionValue>

/**
 * pt-BR labels for the keys the server actually emits. The fallback
 * humanizer below handles anything new, so a premise added on the server is
 * never invisible here — it just reads without accents until it gets a line
 * in this map.
 */
const LABELS: Record<string, string> = {
  aliquotaBps: 'Alíquota',
  atualBps: 'Percentual atual',
  cartoesConsiderados: 'Cartões considerados',
  // Both travel in the same bag: the code for machines, the label for people.
  // Giving them the same caption would print "Classe" twice, in a row.
  classe: 'Código da classe',
  classeLabel: 'Classe',
  classesComMeta: 'Classes com meta',
  classesLiquidas: 'Classes tratadas como líquidas',
  coberturaBps: 'Cobertura',
  compromissosFuturosCents: 'Compromissos futuros',
  compromissosFuturosCount: 'Compromissos futuros (quantidade)',
  compromissosFuturosOrigem: 'Origem dos compromissos',
  comprometimentoBps: 'Comprometimento de renda',
  configurado: 'Configurado pelo usuário',
  contaPJ: 'Conta PJ',
  contasSomadas: 'Contas somadas',
  custoDeVidaManual: 'Custo de vida informado manualmente',
  custoDeVidaMensalCents: 'Custo de vida mensal',
  custoMensalMedioCents: 'Custo mensal médio',
  desvioMedioAbsolutoBps: 'Desvio médio absoluto',
  desvioPorClasse: 'Desvio por classe',
  diasDividaCurtoPrazo: 'Janela de dívida de curto prazo (dias)',
  dividaCurtoPrazoCents: 'Dívida de curto prazo',
  dividasAtivas: 'Dívidas ativas',
  escopo: 'Escopo',
  limiteCartaoOrigem: 'Como este número é medido',
  limiteCartaoComprometidoCents: 'Limite de cartão comprometido',
  faturadoNoPeriodoCents: 'Faturado no período',
  formula: 'Fórmula',
  gapDaReservaCents: 'Falta para completar a reserva',
  gastoCents: 'Gasto realizado',
  goalId: 'Meta de investimento',
  indicadoresComDado: 'Indicadores com dado',
  indicadoresSemDado: 'Indicadores sem dado',
  intervalo: 'Intervalo',
  investimentosIncluidos: 'Investimentos incluídos',
  investimentosLiquidosCents: 'Investimentos líquidos',
  jaDestinadoAMetasCents: 'Já destinado a metas',
  jaDestinadoDetalhe: 'Já destinado, por destino',
  janelaCusto: 'Janela do custo',
  janelaCustoMeses: 'Janela do custo (meses)',
  limiteInferiorDoTeto: 'Múltiplo do teto que zera o indicador',
  mesDeReferencia: 'Mês de referência',
  metaBps: 'Percentual meta',
  metaCents: 'Meta',
  metaDaReservaCents: 'Meta da reserva',
  metasAtivas: 'Metas ativas',
  multiplo: 'Múltiplo',
  nota: 'Nota',
  notaDeEscopo: 'Nota de escopo',
  ordem: 'Ordem',
  ordemDosDestinos: 'Ordem dos destinos',
  origem: 'Origem',
  origemDosParametros: 'Origem de cada parâmetro',
  parametrosUsados: 'Parâmetros usados',
  parcelaMinimaTotalCents: 'Parcela mínima total',
  parcelasDoMesCents: 'Parcelas do mês',
  patrimonioConsideradoCents: 'Patrimônio considerado',
  periodo: 'Período',
  pesoTotalAtivo: 'Peso total ativo',
  pesosConfigurados: 'Pesos configurados',
  receitaDoPeriodoCents: 'Receita do período',
  regrasAvaliadas: 'Regras avaliadas',
  regrasSemDado: 'Regras sem dado',
  rendaDoMesCents: 'Renda do mês',
  reservaAtualCents: 'Reserva acumulada',
  saldoConsolidadoCents: 'Saldo consolidado',
  saldoDisponivelCents: 'Saldo disponível',
  saldoEmContaCents: 'Saldo em conta',
  semDado: 'Sem dado',
  somaDosCustosFixosCents: 'Soma dos custos fixos',
  tetoCents: 'Teto do mês',
  thresholdsConfigurados: 'Limites configurados',
  usoDoTetoBps: 'Uso do teto',
  valorDisponivelCents: 'Valor disponível',
}

function humanize(key: string): string {
  const mapped = LABELS[key]
  if (mapped) return mapped
  const words = key
    .replace(/(Cents|Bps|Count)$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Formats by key suffix, the same convention the whole API uses. */
function formatScalar(key: string, value: unknown): string {
  if (value === null || value === undefined) return 'não informado'
  if (typeof value === 'boolean') return value ? 'sim' : 'não'
  if (typeof value === 'number') {
    if (key.endsWith('Cents')) return money(value)
    if (key.endsWith('Bps')) return bps(value)
    return value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })
  }
  return String(value)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="kv__k">{label}</span>
      <span className="kv__v">{value}</span>
    </>
  )
}

function Entry({ entryKey, value }: { entryKey: string; value: unknown }) {
  const label = humanize(entryKey)

  if (Array.isArray(value)) {
    if (value.length === 0) return <Row label={label} value="nenhum" />
    // An array of records renders one line per record, so a per-class
    // breakdown stays readable instead of collapsing into a count.
    if (isPlainObject(value[0])) {
      return (
        <>
          <span className="kv__k">{label}</span>
          <span className="kv__v">
            {value.map((item, index) => {
              const record = item as Record<string, unknown>
              const name = record.label ?? record.assetClass ?? record.name ?? index + 1
              const rest = Object.entries(record).find(([k]) => k.endsWith('Bps') || k.endsWith('Cents'))
              return (
                <span key={index} style={{ display: 'block' }}>
                  {String(name)}
                  {rest ? `: ${formatScalar(rest[0], rest[1])}` : ''}
                </span>
              )
            })}
          </span>
        </>
      )
    }
    return <Row label={label} value={value.map((item) => String(item)).join(', ')} />
  }

  if (isPlainObject(value)) {
    return (
      <>
        <span className="kv__k">{label}</span>
        <span className="kv__v">
          {Object.entries(value).map(([nestedKey, nestedValue]) => (
            <span key={nestedKey} style={{ display: 'block' }}>
              <span className="muted">{humanize(nestedKey)}: </span>
              {formatScalar(nestedKey, nestedValue)}
            </span>
          ))}
        </span>
      </>
    )
  }

  return <Row label={label} value={formatScalar(entryKey, value)} />
}

export function Assumptions({
  data,
  label = 'Como calculamos',
  compact = false,
}: {
  data: AssumptionBag | undefined | null
  label?: string
  /** Só o ⓘ, sem filete nem rótulo: para quando a mesma divulgação se repete linha a linha dentro de um card. */
  compact?: boolean
}) {
  if (!data) return null

  const { formula, semDado, ...rest } = data as { formula?: string; semDado?: string } & AssumptionBag
  const entries = Object.entries(rest)

  return (
    <details className={compact ? 'assumptions assumptions--compact' : 'assumptions'}>
      <summary title={compact ? label : undefined} aria-label={compact ? label : undefined}>
        <Icon name="info" size={11} strokeWidth={2} />
        {!compact && label}
      </summary>
      <div className="assumptions__body">
        {formula && <p className="assumptions__formula">{formula}</p>}
        {semDado && (
          <p className="assumptions__formula">
            <strong>Sem dado:</strong> {semDado}
          </p>
        )}
        {entries.length > 0 && (
          <div className="kv">
            {entries.map(([key, value]) => (
              <Entry key={key} entryKey={key} value={value} />
            ))}
          </div>
        )}
      </div>
    </details>
  )
}
