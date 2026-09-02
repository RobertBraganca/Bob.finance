import { useMemo, useState } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { money, moneyCompact } from '../../lib/format'
import { themeFor, type Surface } from '../../lib/chartTheme'
import { useEffectiveSurface } from '../../lib/theme'
import { ChartFrame, makeTooltip } from './frame'
import { Icon, RankedList } from '../ui'

export type Slice = {
  categoryId: number | null
  /** only meaningful on a leaf-level slice — which parent it folds under, see `analytics.categoryBreakdown` */
  parentCategoryId?: number | null
  name: string
  color: string
  amountCents: number
  shareBps: number
  transactionCount: number
}

/**
 * Part-to-whole at a glance only. Capped at 6 — matches the group colour
 * picker's own palette (`Categories.tsx` PALETTE, expanded from 4 to 6 on
 * 29/08/2026), so past that the tail folds into "Outras" rather than
 * reusing a colour within the same ring.
 */
const MAX_SEGMENTS = 6

/**
 * Fábrica, não const de módulo: o rótulo da contagem virou prop
 * (`countLabel`) quando a rosca de status de cotação passou a reusar este
 * anel e a contar outra coisa que não lançamento (02/09/2026).
 */
const makeSliceTooltip = (countLabel: string) =>
  makeTooltip<Slice>((slice) => ({
    title: slice.name,
    rows: [
      { label: 'Valor', value: money(slice.amountCents), color: slice.color },
      { label: 'Participação', value: `${(slice.shareBps / 100).toFixed(1)}%` },
      { label: countLabel, value: String(slice.transactionCount) },
    ],
  }))

/**
 * A ring is only honest for part-to-whole at a glance, and it is useless
 * for comparing close values — so it always ships beside a ranked list
 * carrying the exact numbers. The tail folds into "Outras" rather than
 * generating a ninth colour.
 */
export function CategoryRing({
  slices,
  childSlices,
  surface = 'paper',
  totalLabel = 'Total',
  countLabel = 'Lançamentos',
  height = 220,
  paddingAngle = 1.2,
  cornerRadius = 0,
  onSliceClick,
}: {
  slices: Slice[]
  /**
   * Leaf-level breakdown for the SAME range/flow, one row per real
   * category (not folded to its parent) — when given, each parent row in
   * the ranked list below the ring becomes a disclosure that opens to its
   * children, with their own value and share. Omit to keep the plain
   * ranked list (e.g. a caller with no leaf-level data to offer).
   */
  childSlices?: Slice[]
  surface?: Surface
  totalLabel?: string
  /**
   * Como chamar a contagem de cada fatia no tooltip e na tabela. O anel
   * nasceu servindo categorias de lançamento, e o rótulo estava cravado;
   * a rosca de status de cotação reusa o mesmo componente e conta outra
   * coisa (02/09/2026).
   */
  countLabel?: string
  height?: number
  /**
   * Gap between segments, in degrees. Opt-in rather than global: a wide gap
   * eats a thin segment, and this ring is reused where a 0,7% slice is real
   * data (see the caller that raises it).
   */
  paddingAngle?: number
  /** Rounded segment ends. Same reasoning: opt-in per caller. */
  cornerRadius?: number
  /**
   * Optional: clicking a real category-mãe slice (never the synthetic
   * "Outras" bucket, which has no single categoryId) — see
   * `specs/transactions-ledger`, "dropdown de categoria-mãe".
   */
  onSliceClick?: (categoryId: number) => void
}) {
  const theme = themeFor(useEffectiveSurface(surface))
  const SliceTooltip = useMemo(() => makeSliceTooltip(countLabel), [countLabel])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  // Every leaf row folds under its parent (or under itself, when a
  // lançamento is tagged straight on a categoria-mãe with no subcategoria
  // — CategorySelect always offers the parent itself as one option).
  const childrenByParent = useMemo(() => {
    const map = new Map<number, Slice[]>()
    for (const child of childSlices ?? []) {
      const key = child.parentCategoryId ?? child.categoryId
      if (key === null || key === undefined) continue
      const list = map.get(key) ?? []
      list.push(child)
      map.set(key, list)
    }
    for (const list of map.values()) list.sort((a, b) => b.amountCents - a.amountCents)
    return map
  }, [childSlices])

  const { segments, total } = useMemo(() => {
    const sorted = [...slices].sort((a, b) => b.amountCents - a.amountCents)
    const total = sorted.reduce((sum, s) => sum + s.amountCents, 0)
    if (sorted.length <= MAX_SEGMENTS) return { segments: sorted, total }

    const head = sorted.slice(0, MAX_SEGMENTS - 1)
    const tail = sorted.slice(MAX_SEGMENTS - 1)
    const tailAmount = tail.reduce((sum, s) => sum + s.amountCents, 0)
    return {
      segments: [
        ...head,
        {
          categoryId: null,
          name: `Outras (${tail.length})`,
          color: theme.neutral,
          amountCents: tailAmount,
          shareBps: total > 0 ? Math.round((tailAmount / total) * 10_000) : 0,
          transactionCount: tail.reduce((sum, s) => sum + s.transactionCount, 0),
        },
      ],
      total,
    }
  }, [slices, theme.neutral])

  const hasData = total > 0

  return (
    <ChartFrame
      isEmpty={!hasData}
      emptyTitle="Nada categorizado ainda"
      emptyBody="Depois da primeira importação, os gastos aparecem agrupados por categoria aqui."
      table={{
        caption: 'Gastos por categoria',
        rows: segments,
        columns: [
          { header: 'Categoria', value: (row) => row.name },
          { header: countLabel, value: (row) => row.transactionCount, align: 'right' },
          { header: 'Participação', value: (row) => `${(row.shareBps / 100).toFixed(1)}%`, align: 'right' },
          { header: 'Valor', value: (row) => money(row.amountCents), align: 'right' },
        ],
      }}
    >
      <div style={{ position: 'relative' }}>
        <ResponsiveContainer className="chart__plot" width="100%" height="100%" minHeight={height}>
          <PieChart>
            <Pie
              data={segments}
              dataKey="amountCents"
              nameKey="name"
              innerRadius="62%"
              outerRadius="94%"
              startAngle={90}
              endAngle={-270}
              /* A gap in the surface colour separates segments. A stroke
                 drawn around each one would add ink that isn't data. */
              paddingAngle={paddingAngle}
              cornerRadius={cornerRadius}
              stroke={theme.surface}
              strokeWidth={2}
              isAnimationActive={false}
            >
              {segments.map((segment) => (
                <Cell
                  key={`${segment.categoryId ?? 'other'}-${segment.name}`}
                  fill={segment.color}
                  cursor={onSliceClick && segment.categoryId !== null ? 'pointer' : undefined}
                  onClick={
                    onSliceClick && segment.categoryId !== null
                      ? () => onSliceClick(segment.categoryId!)
                      : undefined
                  }
                />
              ))}
            </Pie>
            <Tooltip content={<SliceTooltip />} />
          </PieChart>
        </ResponsiveContainer>

        {/* The centre of a ring is the one place a value belongs — it is the
            whole, not one of the parts. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            pointerEvents: 'none',
            textAlign: 'center',
          }}
        >
          <div>
            <div className="stat__label">{totalLabel}</div>
            <div className="numeral" style={{ fontSize: 'var(--text-lg)' }}>
              {moneyCompact(total)}
            </div>
          </div>
        </div>
      </div>

      {childSlices === undefined ? (
        <RankedList
          items={segments.map((segment) => ({
            key: `${segment.categoryId ?? 'other'}-${segment.name}`,
            name: segment.name,
            color: segment.color,
            amountCents: segment.amountCents,
            shareBps: segment.shareBps,
          }))}
        />
      ) : segments.length === 0 ? (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>Nada no período</p>
      ) : (
        <ul className="ranked">
          {segments.map((segment) => {
            const key = `${segment.categoryId ?? 'other'}-${segment.name}`
            const children = segment.categoryId !== null ? childrenByParent.get(segment.categoryId) ?? [] : []
            // A parent with every real lançamento tagged directly on it (no
            // subcategoria ever used) has exactly one "child" — itself —
            // which would just repeat the row already showing. Nothing to
            // disclose there.
            const canExpand = children.some((c) => c.categoryId !== segment.categoryId)
            const isOpen = segment.categoryId !== null && expanded.has(segment.categoryId)

            return (
              <li key={key} className="ranked__group">
                <button
                  type="button"
                  className="ranked__item ranked__item--toggle"
                  disabled={!canExpand}
                  aria-expanded={canExpand ? isOpen : undefined}
                  onClick={() => {
                    if (!canExpand || segment.categoryId === null) return
                    const id = segment.categoryId
                    setExpanded((prev) => {
                      const next = new Set(prev)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      return next
                    })
                  }}
                >
                  <span className="swatch" style={{ background: segment.color }} />
                  <span className="truncate">{segment.name}</span>
                  <span className="ranked__share">{(segment.shareBps / 100).toFixed(1)}%</span>
                  <span className="ranked__value">{money(segment.amountCents)}</span>
                  {/* A vaga do chevron existe mesmo quando a linha não
                      expande: sem ela, uma linha com subcategorias e outra
                      sem terminavam o valor em posições diferentes na
                      mesma lista. */}
                  {canExpand ? (
                    <Icon
                      name="chevronDown"
                      size={13}
                      className={isOpen ? 'ranked__chevron ranked__chevron--open' : 'ranked__chevron'}
                    />
                  ) : (
                    <span aria-hidden="true" />
                  )}
                </button>
                {canExpand && isOpen && (
                  <ul className="ranked__children">
                    {children.map((child) => (
                      <li key={child.categoryId ?? child.name} className="ranked__item--child">
                        <span className="swatch swatch--sm" style={{ background: child.color }} />
                        <span className="truncate">
                          {child.categoryId === segment.categoryId ? `${child.name} (sem subcategoria)` : child.name}
                        </span>
                        <span className="ranked__share">{(child.shareBps / 100).toFixed(1)}%</span>
                        <span className="ranked__value">{money(child.amountCents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </ChartFrame>
  )
}
