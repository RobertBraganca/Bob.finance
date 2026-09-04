import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { Icon, type IconName } from './Icon'
import { money, signedBps, signedPoints } from '../../lib/format'
import { CategorySelect } from './CategorySelect'
import { FilterSelect } from './FilterSelect'
import { Assumptions, type AssumptionBag } from './Assumptions'
import { DropdownSelect } from './Dropdown'
import { Skeleton } from './skeleton'
import { subscribeToast } from '../../lib/toastBus'

export { Icon, CategorySelect, FilterSelect, Assumptions }
export { PeriodNav } from './PeriodNav'
export { MonthGrid } from './MonthGrid'
export { Bento } from './Bento'
export type { IconName }
export type { AssumptionBag } from './Assumptions'

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */
export function Card({
  title,
  subtitle,
  actions,
  assumptions,
  children,
  span,
  flush,
  muted,
  className,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  /**
   * A memória de cálculo do card, como um ⓘ colado no título.
   *
   * Ela vivia solta no fim do corpo, com filete e o rótulo "Como
   * calculamos" — em telas com seis cards derivados isso viravam seis
   * réguas e seis rótulos idênticos disputando espaço com os números.
   * Presa ao título, a divulgação de `decisions/0010` continua a um
   * clique e some do fluxo de leitura (01/09/2026).
   */
  assumptions?: AssumptionBag | null
  children?: ReactNode
  span?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12
  flush?: boolean
  muted?: boolean
  className?: string
}) {
  return (
    <section
      className={cx(
        'card',
        flush && 'card--flush',
        muted && 'card--muted',
        span && `col-${span}`,
        className,
      )}
    >
      {(title || actions || assumptions) && (
        <header className={cx('card__head', flush && 'card__head--padded')} style={flush ? { padding: 'var(--sp-5) var(--sp-5) 0' } : undefined}>
          <div>
            <div className="card__title-row">
              {title && <h2 className="card__title">{title}</h2>}
              {assumptions && <Assumptions data={assumptions} compact />}
            </div>
            {subtitle && <p className="card__sub">{subtitle}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

/** Ink card. Everything inside gets the on-slab token overrides. */
export function Slab({
  title,
  subtitle,
  actions,
  assumptions,
  children,
  span,
  accent,
  className,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  /** Mesmo ⓘ do `Card`, na mesma posição. */
  assumptions?: AssumptionBag | null
  children?: ReactNode
  span?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12
  accent?: boolean
  className?: string
}) {
  return (
    <section
      className={cx('slab', 'on-slab', accent && 'slab--accent', span && `col-${span}`, className)}
    >
      {(title || actions || assumptions) && (
        <header className="slab__head">
          <div>
            <div className="card__title-row">
              {title && <h2 className="slab__title">{title}</h2>}
              {assumptions && <Assumptions data={assumptions} compact />}
            </div>
            {subtitle && <p className="card__sub">{subtitle}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Figures
 * ------------------------------------------------------------------ */
export function Delta({
  bps,
  label,
  unit = 'percent',
}: {
  bps: number | null
  label?: string
  /**
   * `percent` (padrão) é variação relativa: "receita subiu 12%".
   * `points` é diferença entre duas porcentagens: a participação de
   * parceiros saiu de 14% para 18% — isso é +4 p.p., e imprimir "+4%"
   * afirmaria outra coisa (ver `points` em lib/format.ts, que já existia
   * para o desvio de alocação). Mesma seta, mesma cor, mesmo tamanho: só
   * a unidade muda.
   */
  unit?: 'percent' | 'points'
}) {
  if (bps === null) {
    return <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>sem base de comparação</span>
  }
  const rising = bps > 0
  const flat = bps === 0
  return (
    <span className="delta" style={{ color: flat ? 'var(--ink-3)' : rising ? 'var(--delta-up)' : 'var(--delta-down)' }}>
      {!flat && <Icon name={rising ? 'arrowUpRight' : 'arrowDownLeft'} size={12} strokeWidth={2.2} />}
      {unit === 'points' ? signedPoints(bps) : signedBps(bps)}
      {label && <span className="muted" style={{ fontWeight: 400 }}>{label}</span>}
    </span>
  )
}

/**
 * A single current value plus optional delta — the right form for a
 * headline number. A one-bar bar chart is never the answer.
 */
export function StatTile({
  label,
  value,
  delta,
  deltaLabel,
  deltaUnit,
  foot,
  large,
  spark,
}: {
  label: string
  value: ReactNode
  delta?: number | null
  deltaLabel?: string
  /** Repassado a `Delta` — ver o porquê de `points` lá. */
  deltaUnit?: 'percent' | 'points'
  foot?: ReactNode
  large?: boolean
  /** Série curta para a sparkline do tile: a forma do número ao longo do tempo, sem eixo nem rótulo. */
  spark?: number[]
}) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className={cx('stat__value', large && 'stat__value--lg')}>{value}</span>
      {spark && spark.length > 1 && <Sparkline points={spark} />}
      {(delta !== undefined || foot) && (
        <span className="stat__foot">
          {delta !== undefined && <Delta bps={delta} label={deltaLabel} unit={deltaUnit} />}
          {foot}
        </span>
      )}
    </div>
  )
}

/**
 * Sparkline: só a forma da série, sem eixo, sem grade, sem rótulo — o
 * número grande logo acima já diz onde ela terminou (regra de "sparkline
 * dentro do card de KPI", revisão de 01/09/2026).
 *
 * SVG à mão em vez de Recharts: aqui não há tooltip, legenda nem eixo para
 * justificar o peso da biblioteca, e o tile pode aparecer várias vezes na
 * mesma tela. `preserveAspectRatio="none"` deixa o desenho esticar na
 * largura do card sem recalcular nada em JS.
 */
function Sparkline({ points }: { points: number[] }) {
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min
  const step = points.length > 1 ? 100 / (points.length - 1) : 0
  // Série plana (span 0) desenha no meio: dividir por zero daria NaN e o
  // path sumiria sem nenhum aviso.
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(2)} ${(span === 0 ? 50 : 100 - ((p - min) / span) * 100).toFixed(2)}`)
    .join(' ')

  return (
    <svg className="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="3" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** The one number a view leads with. Exactly one per page. */
export function HeroFigure({
  label,
  value,
  delta,
  deltaLabel,
  children,
}: {
  label: string
  value: string
  delta?: number | null
  deltaLabel?: string
  children?: ReactNode
}) {
  return (
    <div className="stack stack--tight hero-figure__block">
      <span className="stat__label">{label}</span>
      <span className="hero-figure">{value}</span>
      {delta !== undefined && (
        <span className="stat__foot">
          <Delta bps={delta} label={deltaLabel} />
        </span>
      )}
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Meter — a ratio against a limit, with an optional pace marker.
 * The unfilled track is a lighter step of the same ramp, so state reads
 * across the whole bar rather than only in the filled part.
 * ------------------------------------------------------------------ */
export type MeterState = 'on_track' | 'at_risk' | 'exceeded' | 'met' | 'missed' | 'no_target'

const METER_FILL: Record<MeterState, string> = {
  on_track: 'var(--status-good)',
  met: 'var(--status-good)',
  // A decorative fill, not text, so it takes the vivid brand yellow
  // rather than --status-warning's darker (text-safe) step.
  at_risk: 'var(--brand-yellow)',
  exceeded: 'var(--status-critical)',
  missed: 'var(--status-critical)',
  no_target: 'var(--neutral-mark)',
}

export const METER_LABEL: Record<MeterState, string> = {
  on_track: 'No ritmo',
  met: 'Atingido',
  at_risk: 'Em risco',
  exceeded: 'Estourado',
  missed: 'Não atingido',
  no_target: 'Sem meta',
}

const METER_ICON: Record<MeterState, IconName> = {
  on_track: 'check',
  met: 'check',
  at_risk: 'alert',
  exceeded: 'alert',
  missed: 'x',
  no_target: 'info',
}

/**
 * Uso contra um limite rígido (cartão de crédito, qualquer "não pode
 * passar disso"). Um único classificador para que o mesmo % sempre leia a
 * mesma cor, esteja o cartão sendo mostrado no card do Dashboard ou no
 * modal de limite de `CreditCards.tsx` — nunca um segundo corte inventado
 * por tela. Sem conceito de ritmo/tempo: o limite não muda ao longo do mês.
 */
export function capUsageState(usedBps: number): MeterState {
  if (usedBps >= 10_000) return 'exceeded'
  if (usedBps >= 8_000) return 'at_risk'
  return 'on_track'
}

/**
 * Progresso acumulado até uma meta (reserva de emergência, qualquer "quanto
 * já foi construído até agora"), sem conceito de ritmo mensal — por isso
 * nunca é `capState`, que é sobre não passar de um teto dentro do mês, nem
 * `targetState`, que compara contra um período corrente. O corte em 85%
 * segue o mesmo `AT_RISK_AT` usado no motor financeiro (`server/src/
 * services/goals.ts`), para o "quase lá" ler amarelo do mesmo jeito em
 * qualquer barra de progresso-até-meta do app.
 */
export function targetProgressState(progressBps: number | null): MeterState {
  if (progressBps === null) return 'no_target'
  if (progressBps >= 10_000) return 'met'
  if (progressBps >= 8_500) return 'on_track'
  return 'at_risk'
}

/**
 * Nota de 0 a 100 de um indicador de saúde financeira (liquidez,
 * endividamento, gasto, reserva, alocação) — sempre "maior é melhor", sem
 * meta configurada pelo usuário e sem ritmo dentro do mês, por isso um
 * corte fixo em vez de comparar contra `targetCents`/pace de alguém. Ainda
 * assim é uma NOTA, não uma meta inventada: colorir aqui é visualizar o
 * número que a Composição do score já mostra, não adicionar um julgamento
 * novo sobre um alvo que ninguém escolheu (decisions/0010 continua valendo
 * para o texto — nunca "invista", nunca "corte" — só a cor do número).
 */
export function scoreIndicatorState(scoreBps: number | null): MeterState {
  if (scoreBps === null) return 'no_target'
  if (scoreBps >= 7_000) return 'on_track'
  if (scoreBps >= 4_000) return 'at_risk'
  return 'missed'
}

export function Meter({
  usedBps,
  paceBps,
  state,
}: {
  usedBps: number
  paceBps?: number | null
  state: MeterState
}) {
  const width = Math.max(0, Math.min(100, usedBps / 100))
  return (
    <div className="meter">
      <div className="meter__track">
        <div className="meter__fill" style={{ width: `${width}%`, background: METER_FILL[state] }} />
        {paceBps !== null && paceBps !== undefined && paceBps > 0 && paceBps < 10_000 && (
          <span
            className="meter__pace"
            style={{ left: `${Math.min(100, paceBps / 100)}%` }}
            title="Ritmo esperado para hoje"
          />
        )}
      </div>
    </div>
  )
}

/** Status never rides on colour alone: icon + label always travel with it. */
export function StatusBadge({
  state,
  label,
}: {
  state: MeterState
  /**
   * Troca só as PALAVRAS, nunca o tom nem o ícone: "Pronto para saque" lê
   * melhor que "Atingido" numa plataforma de parceiro, mas continua sendo
   * o mesmo estado `met`, com a mesma cor e o mesmo classificador
   * (`targetProgressState`). Sem isso a alternativa era um badge paralelo
   * por tela, que é como um sistema de status vira três.
   */
  label?: string
}) {
  const tone =
    state === 'met' || state === 'on_track'
      ? 'badge--good'
      : state === 'at_risk'
        ? 'badge--warning'
        : state === 'no_target'
          ? ''
          : 'badge--critical'
  return (
    <span className={cx('badge', tone)}>
      <Icon name={METER_ICON[state]} size={11} strokeWidth={2.4} />
      {label ?? METER_LABEL[state]}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */
export function Button({
  children,
  variant = 'ghost',
  size,
  icon,
  onClick,
  disabled,
  type = 'button',
  title,
}: {
  children?: ReactNode
  variant?: 'primary' | 'ghost' | 'quiet' | 'danger' | 'slab'
  size?: 'sm'
  icon?: IconName
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
  title?: string
}) {
  return (
    <button
      type={type}
      /* Sem rótulo, o botão é só o ícone: com o raio de pill (01/09/2026)
         ele viraria uma cápsula oval larga em vez de um alvo redondo. */
      className={cx('btn', `btn--${variant}`, size && `btn--${size}`, children === undefined && 'btn--icon')}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 13 : 15} />}
      {children}
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  ariaLabel: string
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__btn"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  children: (id: string) => ReactNode
}) {
  const id = useId()
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  )
}

export function TextInput({
  id,
  value,
  onChange,
  placeholder,
  numeral,
  type = 'text',
  min,
  max,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  numeral?: boolean
  type?: string
  min?: string | number
  max?: string | number
}) {
  return (
    <input
      id={id}
      className={cx('input', numeral && 'input--numeral')}
      value={value}
      type={type}
      min={min}
      max={max}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function Select<T extends string | number>({
  id,
  value,
  options,
  onChange,
  placeholder,
  bare,
  toolbar,
  className,
}: {
  id?: string
  value: T | null
  options: Array<{ value: T; label: string }>
  onChange: (value: T | null) => void
  placeholder?: string
  bare?: boolean
  /** Same chrome as a ghost/sm button, for sitting directly beside one in a toolbar row. */
  toolbar?: boolean
  /** Variante visual do gatilho (ex. `select--pill select--good` para status). */
  className?: string
}) {
  return (
    <DropdownSelect
      groups={[{ options }]}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      renderTrigger={({ label, triggerProps }) => (
        <button
          id={id}
          {...triggerProps}
          className={cx('select', bare && 'select--bare', toolbar && 'select--toolbar', className)}
        >
          <span className="select__value truncate">{label}</span>
        </button>
      )}
    />
  )
}

/* ------------------------------------------------------------------ *
 * Empty states — designed, not an afterthought. Every chart and table
 * in this app renders one of these before the first CSV is imported.
 * ------------------------------------------------------------------ */
export function EmptyState({
  icon = 'sparkle',
  title,
  body,
  action,
}: {
  icon?: IconName
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <span className="empty__glyph">
        <Icon name={icon} size={26} strokeWidth={1.4} />
      </span>
      <span className="empty__title">{title}</span>
      {body && <p className="empty__body">{body}</p>}
      {action}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Modal
 * ------------------------------------------------------------------ */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'modal--wide')} role="dialog" aria-modal="true" aria-label={title}>
        <header className="row row--between">
          <h2 className="h2">{title}</h2>
          <Button variant="quiet" icon="x" onClick={onClose} title="Fechar" />
        </header>
        {children}
        {footer && <footer className="row row--between">{footer}</footer>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */
type Toast = { id: number; message: string; tone: 'info' | 'error' }
const ToastContext = createContext<(message: string, tone?: 'info' | 'error') => void>(() => {})

export const useToast = () => useContext(ToastContext)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    const id = Date.now() + Math.floor(performance.now() % 1000)
    setToasts((current) => [...current, { id, message, tone }])
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 5200)
  }, [])

  const value = useMemo(() => push, [push])

  // Bridges `api.ts` (a plain module — can't call useToast()) so a failed
  // GET surfaces a toast even on a page that never wired its own onError.
  useEffect(() => subscribeToast(push), [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={cx('toast', toast.tone === 'error' && 'toast--error')}>
            <Icon name={toast.tone === 'error' ? 'alert' : 'check'} size={14} strokeWidth={2.2} />
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/* ------------------------------------------------------------------ *
 * Ranked list — the table twin that sits beside every ring chart, so a
 * value is never reachable only through a tooltip or a colour.
 * ------------------------------------------------------------------ */
export function RankedList({
  items,
  emptyLabel = 'Nada no período',
}: {
  items: Array<{ key: string | number; name: string; color: string; amountCents: number; shareBps: number }>
  emptyLabel?: string
}) {
  if (items.length === 0) return <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>{emptyLabel}</p>
  return (
    <ul className="ranked">
      {items.map((item) => (
        <li key={item.key} className="ranked__item">
          <span className="swatch" style={{ background: item.color }} />
          <span className="truncate">{item.name}</span>
          <span className="ranked__share">{(item.shareBps / 100).toFixed(1)}%</span>
          <span className="ranked__value">{money(item.amountCents)}</span>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------ *
 * Skeletons — carregamento espelhando o layout real (linhas de texto,
 * blocos pra gráfico/diagrama, pares label+valor pras estatísticas),
 * nunca um retângulo genérico solto na tela.
 * ------------------------------------------------------------------ */
type CardSpan = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12

export function SkeletonLines({ lines = 3, lastWidth = '55%' }: { lines?: number; lastWidth?: string }) {
  return (
    <div className="stack stack--tight" aria-busy="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-full" style={i === lines - 1 ? { width: lastWidth } : undefined} />
      ))}
    </div>
  )
}

export function SkeletonBlock({ height = 220 }: { height?: number }) {
  return <Skeleton className="w-full" style={{ height }} aria-busy="true" />
}

export function SkeletonStats({ items = 3 }: { items?: number }) {
  return (
    <div className="row row--wrap" style={{ gap: 'var(--sp-5)' }} aria-busy="true">
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="stack stack--tight" style={{ minWidth: 88 }}>
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-6 w-20" />
        </div>
      ))}
    </div>
  )
}

export function CardSkeleton({
  span,
  variant = 'lines',
  lines = 3,
  height = 220,
}: {
  span?: CardSpan
  variant?: 'lines' | 'stats' | 'block'
  lines?: number
  height?: number
}) {
  return (
    <Card span={span}>
      {variant === 'block' && <SkeletonBlock height={height} />}
      {variant === 'stats' && <SkeletonStats />}
      {variant === 'lines' && <SkeletonLines lines={lines} />}
    </Card>
  )
}

export function PageSkeleton({
  cards,
}: {
  cards: Array<{ span?: CardSpan; variant?: 'lines' | 'stats' | 'block'; lines?: number; height?: number }>
}) {
  return (
    <div className="bento">
      {cards.map((c, i) => (
        <CardSkeleton key={i} {...c} />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * PendingScopeModal — decisions/0020: excluir uma parcela de dívida ou
 * fluxo de caixa pergunta o escopo (só esta / esta e as futuras / todas),
 * nunca decide sozinha. Um único componente, reaproveitado onde quer que
 * uma pendência vinculada a um template seja excluída (Lançamentos, o
 * card de pendência do Painel, pagamento de dívida) — nunca um segundo
 * modal parecido implementado à parte.
 * ------------------------------------------------------------------ */
export type PendingDeleteScope = 'only' | 'this_and_future' | 'all'

export function PendingScopeModal({
  onCancel,
  onConfirm,
  pending,
}: {
  onCancel: () => void
  onConfirm: (scope: PendingDeleteScope) => void
  pending?: boolean
}) {
  return (
    <Modal title="Excluir pendência recorrente" onClose={onCancel}>
      <div className="stack">
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          Esta pendência faz parte de um template que se repete. O que você quer excluir?
        </p>
        <div className="stack stack--tight">
          <Button variant="ghost" onClick={() => onConfirm('only')} disabled={pending}>
            Apenas esta ocorrência
          </Button>
          <Button variant="ghost" onClick={() => onConfirm('this_and_future')} disabled={pending}>
            Esta e as futuras
          </Button>
          <Button variant="danger" onClick={() => onConfirm('all')} disabled={pending}>
            Todas as ocorrências (encerra o template)
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * decisions/0029 — mesma pergunta de escopo de `PendingScopeModal`, agora
 * para EDITAR (não excluir) uma ocorrência vinculada a um template
 * (previsão recorrente ou dívida). "Esta e as futuras"/"Todas" também
 * atualizam o próprio template — um reajuste de salário só vale de fato se
 * os meses que ainda vão ser lançados também herdarem o valor novo.
 */
export function PendingEditScopeModal({
  onCancel,
  onConfirm,
  pending,
}: {
  onCancel: () => void
  onConfirm: (scope: PendingDeleteScope) => void
  pending?: boolean
}) {
  return (
    <Modal title="Editar pendência recorrente" onClose={onCancel}>
      <div className="stack">
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          Esta pendência faz parte de um template que se repete. O que você quer alterar?
        </p>
        <div className="stack stack--tight">
          <Button variant="ghost" onClick={() => onConfirm('only')} disabled={pending}>
            Apenas esta ocorrência
          </Button>
          <Button variant="ghost" onClick={() => onConfirm('this_and_future')} disabled={pending}>
            Esta e as futuras
          </Button>
          <Button variant="primary" onClick={() => onConfirm('all')} disabled={pending}>
            Todas as ocorrências já lançadas
          </Button>
        </div>
        <p className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
          "Esta e as futuras" e "Todas" também atualizam o modelo: os próximos meses ainda não
          lançados vão usar o novo valor quando forem gerados.
        </p>
      </div>
    </Modal>
  )
}
