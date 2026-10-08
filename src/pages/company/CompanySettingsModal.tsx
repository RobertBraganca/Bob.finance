import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { centsToInput, date as fmtDate, money, parseMoneyInput } from '../../lib/format'
import { Button, LoadError, Modal, SkeletonLines, TextInput, useToast } from '../../components/ui'
import type { CompanySettings } from './types'

/** Ajustes de "Minha empresa": DAS mensal, meses de colchão, teto do MEI e TAGs de DAS. */
export function CompanySettingsModal({ onClose }: { onClose: () => void }) {
  const query = useQuery({ queryKey: ['company-settings'], queryFn: () => api.get<CompanySettings>('/company/settings') })
  return (
    <Modal title="Ajustar Minha empresa" onClose={onClose}>
      {query.isError ? (
        <LoadError onRetry={() => query.refetch()} retrying={query.isFetching} />
      ) : !query.data ? (
        <SkeletonLines lines={5} />
      ) : (
        <SettingsForm settings={query.data} onClose={onClose} />
      )}
    </Modal>
  )
}

function SettingsForm({ settings, onClose }: { settings: CompanySettings; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [das, setDas] = useState(centsToInput(settings.dasMonthlyCents))
  const [months, setMonths] = useState(String(settings.pjCushionMonths).replace('.', ','))
  const [limit, setLimit] = useState(centsToInput(settings.meiAnnualLimitCents))
  const [auto, setAuto] = useState(settings.dasCategoryIds === null)
  const [picked, setPicked] = useState(() => new Set(settings.effectiveDasCategoryIds))
  const byId = new Map(settings.categories.map((c) => [c.id, c]))
  const label = (id: number) => {
    const c = byId.get(id)
    if (!c) return `#${id}`
    const parent = c.parentId === null ? null : byId.get(c.parentId)
    return parent ? `${parent.name} › ${c.name}` : c.name
  }

  const save = useMutation({
    mutationFn: () => {
      const cushion = Number(months.replace(',', '.'))
      if (!Number.isFinite(cushion) || cushion < 0 || cushion > 24) throw new Error('meses de colchão entre 0 e 24')
      const limitCents = parseMoneyInput(limit)
      if (!limitCents || limitCents <= 0) throw new Error('informe o teto anual')
      const dasCents = das.trim() ? Math.abs(parseMoneyInput(das) ?? 0) : null
      return api.put('/company/settings', {
        dasMonthlyCents: dasCents,
        pjCushionMonths: cushion,
        meiAnnualLimitCents: Math.abs(limitCents),
        dasCategoryIds: auto ? null : [...picked],
      })
    },
    onSuccess: () => {
      toast('Ajustes salvos')
      queryClient.invalidateQueries({ queryKey: ['company'] })
      queryClient.invalidateQueries({ queryKey: ['company-settings'] })
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <div className="stack">
      <div className="field">
        <label className="field__label" htmlFor="company-das">
          DAS mensal (R$)
        </label>
        <TextInput
          id="company-das"
          value={das}
          onChange={setDas}
          numeral
          placeholder={settings.lastDasPaid ? centsToInput(settings.lastDasPaid.cents) : '0,00'}
        />
        <span className="field__hint">
          {settings.lastDasPaid
            ? `Vazio usa o último DAS encontrado na PJ: ${money(settings.lastDasPaid.cents)} em ${fmtDate(settings.lastDasPaid.postedOn)}.`
            : 'Nenhum DAS encontrado na conta da empresa ainda.'}
        </span>
      </div>
      <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label className="field__label" htmlFor="company-cushion">
            Colchão da PJ (meses)
          </label>
          <TextInput id="company-cushion" value={months} onChange={setMonths} numeral />
          <span className="field__hint">Meses de custo fixo da empresa que ficam antes da retirada possível.</span>
        </div>
        <div className="field" style={{ flex: 1, minWidth: 150 }}>
          <label className="field__label" htmlFor="company-limit">
            Teto anual do MEI (R$)
          </label>
          <TextInput id="company-limit" value={limit} onChange={setLimit} numeral />
        </div>
      </div>
      <div className="field">
        <span className="field__label">TAGs do DAS</span>
        <label className="check-row">
          <input type="checkbox" className="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>Detectar pelo nome (TAGs com "imposto" ou "DAS")</span>
        </label>
        {auto ? (
          <span className="field__hint">Detectadas: {settings.effectiveDasCategoryIds.map(label).join(', ') || 'nenhuma'}.</span>
        ) : (
          <ul className="asset-pick">
            {settings.categories.map((c) => (
              <li key={c.id}>
                <label className="asset-pick__row">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={picked.has(c.id)}
                    onChange={() =>
                      setPicked((current) => {
                        const next = new Set(current)
                        if (next.has(c.id)) next.delete(c.id)
                        else next.add(c.id)
                        return next
                      })
                    }
                  />
                  <span className="asset-pick__name">{label(c.id)}</span>
                  <span />
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="row" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
        <Button variant="quiet" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate()}>
          Salvar
        </Button>
      </div>
    </div>
  )
}
