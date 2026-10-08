import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'
import { api } from '../../lib/api'
import { bps, money } from '../../lib/format'
import { FULL_BPS, METHOD_SEED, normalizeTo10000 } from '@shared/budget'
import { Button, Card, Modal, TextInput, useToast } from '../../components/ui'
import { GROUP_COLORS, SOURCE_NOTE, type BudgetGroup, type BudgetSettings } from './types'

/**
 * Percentuais por grupo: o meio-círculo da distribuição, um controle por
 * grupo e "Alocado X% / 100%". Nada grava até Salvar, e só salva somando
 * 100% (specs/budget-groups).
 */
export function AllocationPanel({ settings }: { settings: BudgetSettings }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const active = settings.groups.filter((g) => !g.archived)
  const saved = useMemo(() => new Map((settings.plan?.allocations ?? []).map((a) => [a.groupId, a.targetBps])), [settings.plan])
  const [values, setValues] = useState<Map<number, number>>(() => new Map(active.map((g) => [g.id, saved.get(g.id) ?? 0])))
  const [editing, setEditing] = useState<BudgetGroup | 'new' | null>(null)
  const history = new Map(settings.history.map((h) => [h.groupId, h.shareBps]))

  const total = active.reduce((sum, g) => sum + (values.get(g.id) ?? 0), 0)
  const dirty = active.some((g) => (values.get(g.id) ?? 0) !== (saved.get(g.id) ?? 0))
  const set = (id: number, bpsValue: number) => setValues((current) => new Map(current).set(id, Math.max(0, Math.min(FULL_BPS, bpsValue))))

  const resetToMethod = () => {
    const byName = new Map(METHOD_SEED.map((s) => [s.name, s.targetBps]))
    setValues(new Map(active.map((g) => [g.id, byName.get(g.name) ?? 0])))
  }
  const useHistory = () => {
    const normalized = normalizeTo10000(active.map((g) => history.get(g.id) ?? 0))
    setValues(new Map(active.map((g, i) => [g.id, normalized[i]!])))
  }
  const hasHistory = active.some((g) => (history.get(g.id) ?? 0) > 0)

  const save = useMutation({
    mutationFn: () => api.put('/budget/plan', { allocations: active.map((g) => ({ groupId: g.id, targetBps: values.get(g.id) ?? 0 })) }),
    onSuccess: () => {
      toast('Percentuais salvos a partir deste mês')
      queryClient.invalidateQueries({ queryKey: ['budget'] })
      queryClient.invalidateQueries({ queryKey: ['budget-settings'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const incomeCents = settings.income.cents
  const slices = active.map((g) => ({ id: g.id, name: g.name, color: g.color, value: values.get(g.id) ?? 0 })).filter((s) => s.value > 0)

  return (
    <div className="budget-settings">
      <Card title="Distribuição" subtitle="Como a renda se divide entre os grupos">
        <div className="stack">
          <div className="allocation-donut" aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices.length ? slices : [{ id: 0, name: '', color: 'var(--line)', value: 1 }]}
                  dataKey="value"
                  startAngle={180}
                  endAngle={0}
                  cx="50%"
                  cy="100%"
                  // Meio círculo numa caixa 2:1: o raio útil do Recharts é metade da
                  // altura, então 200% é o arco encostando na borda de cima.
                  innerRadius="128%"
                  outerRadius="196%"
                  paddingAngle={slices.length > 1 ? 1.5 : 0}
                  stroke="none"
                  isAnimationActive={false}
                >
                  {(slices.length ? slices : [{ id: 0, color: 'var(--line)' }]).map((s) => (
                    <Cell key={s.id} fill={s.color} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="allocation-donut__center">
              <span className={`allocation-donut__value numeral${total === FULL_BPS ? '' : ' allocation-donut__value--off'}`}>{bps(total, 0)}</span>
              <span className="field__hint">alocado</span>
            </div>
          </div>
          <ul className="allocation-legend">
            {active.map((g) => (
              <li key={g.id}>
                <span className="allocation-legend__dot" style={{ background: g.color }} aria-hidden="true" />
                <span className="allocation-legend__name">{g.name}</span>
                <span className="numeral">{bps(values.get(g.id) ?? 0, 0)}</span>
              </li>
            ))}
          </ul>
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            <Button size="sm" icon="refresh" onClick={resetToMethod}>
              Voltar ao método
            </Button>
            <Button size="sm" icon="clock" onClick={useHistory} disabled={!hasHistory} title={hasHistory ? undefined : 'Sem meses fechados com renda para medir'}>
              Usar meu histórico
            </Button>
          </div>
          <p className="chart__note">
            "Meu histórico" é quanto cada grupo levou da sua renda nos últimos {settings.historyMonths || 6} meses fechados, com as TAGs
            ligadas hoje. Os percentuais valem deste mês em diante; os meses passados guardam os seus.
          </p>
        </div>
      </Card>

      <Card
        title="Percentuais por grupo"
        subtitle={incomeCents > 0 ? `Valores com a renda de ${money(incomeCents)}${settings.income.estimated ? ' (estimada)' : ''}` : 'Sem renda no mês para converter em R$'}
        actions={
          <Button size="sm" variant="quiet" icon="plus" onClick={() => setEditing('new')}>
            Novo grupo
          </Button>
        }
      >
        <div className="stack">
          {active.map((g) => {
            const value = values.get(g.id) ?? 0
            const hist = history.get(g.id)
            return (
              <AllocationRow
                key={g.id}
                group={g}
                valueBps={value}
                incomeCents={incomeCents}
                historyBps={hist}
                onChange={(next) => set(g.id, next)}
                onEdit={() => setEditing(g)}
              />
            )
          })}
          <div className="allocation-total">
            <span>Alocado</span>
            <span className={`numeral ${total === FULL_BPS ? 'allocation-total--ok' : 'allocation-total--off'}`}>
              {bps(total, 0)} / 100%
            </span>
          </div>
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
            {dirty && (
              <Button variant="quiet" onClick={() => setValues(new Map(active.map((g) => [g.id, saved.get(g.id) ?? 0])))}>
                Desfazer
              </Button>
            )}
            <Button variant="primary" icon="check" disabled={total !== FULL_BPS || !dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Salvar percentuais
            </Button>
          </div>
          {total !== FULL_BPS && (
            <p className="field__hint">
              {total > FULL_BPS ? `Passou ${bps(total - FULL_BPS, 0)} de 100%.` : `Faltam ${bps(FULL_BPS - total, 0)} para 100%.`}
            </p>
          )}
        </div>
      </Card>

      {editing && <GroupModal group={editing === 'new' ? null : editing} usedColors={active.map((g) => g.color)} onClose={() => setEditing(null)} />}
    </div>
  )
}

function AllocationRow({
  group,
  valueBps,
  incomeCents,
  historyBps,
  onChange,
  onEdit,
}: {
  group: BudgetGroup
  valueBps: number
  incomeCents: number
  historyBps: number | undefined
  onChange: (bps: number) => void
  onEdit: () => void
}) {
  const pct = Math.round(valueBps / 100)
  const note = SOURCE_NOTE[group.source]
  return (
    <div className="allocation-row" style={{ ['--group-color' as string]: group.color }}>
      <div className="allocation-row__head">
        <button type="button" className="allocation-row__name" onClick={onEdit} title="Renomear, trocar a cor ou remover">
          <span className="budget-card__dot" aria-hidden="true" />
          {group.name}
        </button>
        <div className="allocation-row__input">
          <TextInput
            value={String(pct)}
            onChange={(raw) => {
              const n = Number(raw.replace(',', '.'))
              if (raw.trim() === '') onChange(0)
              else if (Number.isFinite(n)) onChange(Math.round(n * 100))
            }}
            numeral
            ariaLabel={`Percentual de ${group.name}`}
          />
          <span aria-hidden="true">%</span>
        </div>
      </div>
      <input
        type="range"
        className="allocation-row__slider"
        min={0}
        max={100}
        step={1}
        value={pct}
        onChange={(event) => onChange(Number(event.target.value) * 100)}
        aria-label={`${group.name}: ${pct}% da renda`}
        style={{ ['--fill' as string]: `${pct}%` }}
      />
      <div className="allocation-row__meta">
        <span>{note ?? (historyBps !== undefined ? `seu histórico: ${bps(historyBps, 0)}` : '')}</span>
        <span className="numeral">{incomeCents > 0 ? `≈ ${money(Math.round((incomeCents * valueBps) / FULL_BPS))} por mês` : ''}</span>
      </div>
      {note && historyBps !== undefined && <div className="allocation-row__meta"><span>seu histórico: {bps(historyBps, 0)}</span></div>}
    </div>
  )
}

function GroupModal({ group, usedColors, onClose }: { group: BudgetGroup | null; usedColors: string[]; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [name, setName] = useState(group?.name ?? '')
  const [color, setColor] = useState(group?.color ?? GROUP_COLORS.find((c) => !usedColors.includes(c)) ?? GROUP_COLORS[0]!)
  const done = (message: string) => {
    toast(message)
    queryClient.invalidateQueries({ queryKey: ['budget'] })
    queryClient.invalidateQueries({ queryKey: ['budget-settings'] })
    onClose()
  }
  const save = useMutation({
    mutationFn: () => (group ? api.patch(`/budget/groups/${group.id}`, { name: name.trim(), color }) : api.post('/budget/groups', { name: name.trim(), color })),
    onSuccess: () => done(group ? 'Grupo atualizado' : 'Grupo criado com 0%'),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })
  const archive = useMutation({
    mutationFn: () => api.patch(`/budget/groups/${group!.id}`, { archived: true }),
    onSuccess: () => done('Grupo removido; redistribua os percentuais'),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })
  return (
    <Modal
      title={group ? `Editar ${group.name}` : 'Novo grupo'}
      onClose={onClose}
      footer={
        <>
          {group ? (
            <Button variant="danger" icon="trash" loading={archive.isPending} onClick={() => archive.mutate()}>
              Remover
            </Button>
          ) : (
            <span />
          )}
          <span className="row" style={{ gap: 'var(--sp-2)' }}>
            <Button variant="quiet" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="primary" icon="check" disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
              Salvar
            </Button>
          </span>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label className="field__label" htmlFor="budget-group-name">
            Nome
          </label>
          <TextInput id="budget-group-name" value={name} onChange={setName} placeholder="ex. Família" />
        </div>
        <div className="field">
          <span className="field__label">Cor</span>
          <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }} role="radiogroup" aria-label="Cor do grupo">
            {GROUP_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === color}
                aria-label={`Cor ${c}`}
                className="color-swatch"
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>
        {group && group.source !== 'categories' && (
          <p className="chart__note">Este grupo {SOURCE_NOTE[group.source]}. Removê-lo tira esses aportes do orçamento.</p>
        )}
        {group && <p className="chart__note">Remover arquiva o grupo: os meses que já o usavam continuam mostrando-o.</p>}
      </div>
    </Modal>
  )
}
