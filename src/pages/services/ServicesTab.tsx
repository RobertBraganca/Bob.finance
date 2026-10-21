import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { centsToInput, date as fmtDate, money, parseMoneyInput } from '../../lib/format'
import { Button, Card, ConfirmDeleteModal, EmptyState, Field, KpiTile, Modal, SkeletonLines, TextArea, TextInput, useToast } from '../../components/ui'
import { useServiceCatalog, type CatalogService, type UncataloguedService } from './useServiceCatalog'

type Draft = { service: CatalogService } | { fromTitle: UncataloguedService } | 'new'

/**
 * Aba Serviços de Precificação (specs/clientes-e-negocios, fase 3): o catálogo
 * leve que se escolhe ao montar o orçamento, com o que cada serviço já vendeu
 * nos orçamentos aprovados. Os itens sem catálogo aparecem agrupados pelo
 * título, para ver o que vale cadastrar. Só observa (decisions/0010).
 */
export function ServicesTab({ creating, onCloseCreate }: { creating: boolean; onCloseCreate: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const catalog = useServiceCatalog()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [deleting, setDeleting] = useState<CatalogService | null>(null)
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['services'] })
  }

  const adopt = useMutation({
    mutationFn: (id: number) => api.post<{ linked: number }>(`/pricing/services/${id}/adopt`, {}),
    onSuccess: ({ linked }) => {
      toast(linked === 0 ? 'Nenhum item antigo com esse nome' : linked === 1 ? '1 item antigo ligado ao serviço' : `${linked} itens antigos ligados ao serviço`)
      refresh()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao ligar os itens', 'error'),
  })
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/pricing/services/${id}`),
    onSuccess: () => {
      toast('Serviço removido do catálogo')
      setDeleting(null)
      refresh()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  const services = catalog.data?.services ?? []
  const loose = catalog.data?.uncatalogued ?? []
  const soldCents = services.reduce((sum, s) => sum + s.stats.revenueCents, 0)
  const looseCents = loose.reduce((sum, s) => sum + s.revenueCents, 0)
  const top = [...services].sort((a, b) => b.stats.revenueCents - a.stats.revenueCents)[0]
  const editing = creating ? 'new' : draft

  return (
    <div className="stack stack--loose">
      <div className="kpi-row kpi-row--3">
        <KpiTile
          accent
          label="Vendido pelo catálogo"
          value={catalog.data ? money(soldCents) : '-'}
          foot={catalog.data ? <span>{services.length === 1 ? '1 serviço cadastrado' : `${services.length} serviços cadastrados`}</span> : undefined}
          assumptions={{ base: catalog.data?.assumptions.base ?? '', receita: catalog.data?.assumptions.receita ?? '' }}
        />
        <KpiTile
          label="Mais vendido"
          value={top && top.stats.revenueCents > 0 ? top.name : '-'}
          foot={top && top.stats.revenueCents > 0 ? <span>{money(top.stats.revenueCents)} em {top.stats.timesSold === 1 ? '1 venda' : `${top.stats.timesSold} vendas`}</span> : <span>nenhuma venda pelo catálogo ainda</span>}
          assumptions={{ formula: 'O serviço do catálogo com mais receita nos orçamentos aprovados.' }}
        />
        <KpiTile
          label="Fora do catálogo"
          value={catalog.data ? money(looseCents) : '-'}
          foot={<span>vendido com título livre, entre os 10 maiores</span>}
          assumptions={{ formula: catalog.data?.assumptions.semCatalogo ?? '' }}
        />
      </div>

      <Card flush title="Catálogo" subtitle={catalog.data ? `${services.length} ${services.length === 1 ? 'serviço' : 'serviços'}` : undefined}>
        {catalog.isError ? (
          <EmptyState icon="alert" title="Falha ao carregar" body="Não foi possível carregar o catálogo agora. Tente de novo em instantes." />
        ) : !catalog.data ? (
          <div style={{ padding: 'var(--sp-5)' }}>
            <SkeletonLines lines={4} />
          </div>
        ) : services.length === 0 ? (
          <EmptyState
            icon="layers"
            title="Nenhum serviço no catálogo"
            body="Cadastre o que você vende, com um preço de partida. No orçamento, escolha do catálogo e os números de cada serviço passam a somar juntos."
            action={
              <Button icon="plus" onClick={() => setDraft('new')}>
                Cadastrar serviço
              </Button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table table--stack-mobile table--stack-compact">
              <thead>
                <tr>
                  <th scope="col">Serviço</th>
                  <th scope="col" className="table__num">Preço de partida</th>
                  <th scope="col" className="table__num">Vendas</th>
                  <th scope="col" className="table__num">Receita</th>
                  <th scope="col" className="table__num">Clientes</th>
                  <th scope="col">Última venda</th>
                  <th scope="col" style={{ width: 120 }} />
                </tr>
              </thead>
              <tbody>
                {services.map((s) => (
                  <tr key={s.id}>
                    <td data-label="__lead">
                      <span style={{ minWidth: 0 }}>
                        <strong style={{ fontWeight: 600 }}>{s.name}</strong>
                        {!s.active && <span className="badge" style={{ marginLeft: 6 }}>Fora de uso</span>}
                        {/* Só o resumo (a primeira linha), numa linha: o escopo inteiro fica no serviço e abre no Editar. */}
                        {s.description && (
                          <span className="muted service-summary" title={s.description}>
                            {s.description.split('\n')[0]}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="table__num" data-label="Preço de partida">{s.defaultPriceCents > 0 ? money(s.defaultPriceCents) : <span className="muted">-</span>}</td>
                    <td className="table__num" data-label="Vendas">{s.stats.timesSold}</td>
                    <td className="table__num" data-label="Receita">
                      <strong className="tabular">{money(s.stats.revenueCents)}</strong>
                    </td>
                    <td className="table__num" data-label="Clientes">{s.stats.clients}</td>
                    <td data-label="Última venda">{s.stats.lastSoldOn ? fmtDate(s.stats.lastSoldOn) : <span className="muted">-</span>}</td>
                    <td data-label="__trail">
                      <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="link"
                          title={`Ligar a ${s.name} os itens antigos com o mesmo título`}
                          onClick={() => adopt.mutate(s.id)}
                          disabled={adopt.isPending}
                        />
                        <Button variant="quiet" size="sm" icon="pencil" title={`Editar ${s.name}`} onClick={() => setDraft({ service: s })} />
                        <Button variant="quiet" size="sm" icon="trash" title={`Remover ${s.name}`} onClick={() => setDeleting(s)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {loose.length > 0 && (
        <Card title="Vendido fora do catálogo" subtitle="Itens de orçamentos aprovados com título livre, agrupados pelo título">
          <ul className="stack stack--tight">
            {loose.map((u) => (
              <li key={u.title} className="row row--between" style={{ gap: 'var(--sp-2)' }}>
                <span style={{ minWidth: 0 }}>
                  <strong style={{ fontWeight: 600 }}>{u.title}</strong>
                  <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                    {u.timesSold === 1 ? '1 venda' : `${u.timesSold} vendas`} · {u.clients === 1 ? '1 cliente' : `${u.clients} clientes`} · {money(u.revenueCents)}
                  </span>
                </span>
                <Button size="sm" icon="plus" onClick={() => setDraft({ fromTitle: u })}>
                  Pôr no catálogo
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {editing && (
        <ServiceFormModal
          draft={editing}
          onClose={() => {
            setDraft(null)
            onCloseCreate()
          }}
          onSaved={refresh}
        />
      )}
      {deleting && (
        <ConfirmDeleteModal
          title={`Remover ${deleting.name} do catálogo?`}
          body="Os itens dos orçamentos continuam como estão, só deixam de somar neste serviço. Para só esconder do seletor, edite e marque como fora de uso."
          confirmLabel="Remover serviço"
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id)}
        />
      )}
    </div>
  )
}

function ServiceFormModal({ draft, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const service = typeof draft === 'object' && 'service' in draft ? draft.service : null
  const fromTitle = typeof draft === 'object' && 'fromTitle' in draft ? draft.fromTitle : null
  const [name, setName] = useState(service?.name ?? fromTitle?.title ?? '')
  const [description, setDescription] = useState(service?.description ?? '')
  const [price, setPrice] = useState(
    service ? centsToInput(service.defaultPriceCents) : fromTitle && fromTitle.quantity > 0 ? centsToInput(Math.round(fromTitle.revenueCents / fromTitle.quantity)) : '',
  )
  const [active, setActive] = useState(service?.active ?? true)
  const priceCents = price.trim() === '' ? 0 : parseMoneyInput(price)

  const save = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim(), description: description.trim() || null, defaultPriceCents: Math.abs(priceCents ?? 0), active }
      if (service) return { saved: await api.patch<CatalogService>(`/pricing/services/${service.id}`, body), linked: 0 }
      const saved = await api.post<CatalogService>('/pricing/services', body)
      // Veio de um título já vendido: liga de uma vez os itens antigos com esse nome.
      const linked = fromTitle ? (await api.post<{ linked: number }>(`/pricing/services/${saved.id}/adopt`, {})).linked : 0
      return { saved, linked }
    },
    onSuccess: ({ saved, linked }) => {
      toast(service ? 'Serviço atualizado' : linked > 0 ? `${saved.name} no catálogo, com ${linked === 1 ? '1 item antigo ligado' : `${linked} itens antigos ligados`}` : `${saved.name} no catálogo`)
      onSaved()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar o serviço', 'error'),
  })

  return (
    <Modal
      title={service ? `Editar ${service.name}` : 'Novo serviço'}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={save.isPending}>
            Cancelar
          </Button>
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={!name.trim() || priceCents === null} loading={save.isPending}>
            {service ? 'Salvar serviço' : 'Cadastrar serviço'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Nome">{(id) => <TextInput id={id} value={name} onChange={setName} placeholder="ex. Identidade visual" />}</Field>
        <Field label="Descrição e escopo" hint="Na lista aparece só a primeira linha. Entra no item do orçamento quando ele ainda não tem descrição.">
          {(id) => <TextArea id={id} value={description} onChange={setDescription} rows={8} placeholder="Resumo na primeira linha; depois o que inclui, o que fica de fora e o prazo" />}
        </Field>
        <Field
          label="Preço de partida (R$)"
          hint={fromTitle ? 'Sugerido pela média do que já foi vendido com esse título.' : 'Opcional. No orçamento, o preço continua editável.'}
          error={priceCents === null ? 'Confira o valor.' : null}
        >
          {(id) => <TextInput id={id} value={price} onChange={setPrice} placeholder="0,00" numeral />}
        </Field>
        <label className="row" style={{ gap: 'var(--sp-2)', cursor: 'pointer', minHeight: 44 }}>
          <input type="checkbox" className="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
          <span style={{ fontSize: 'var(--text-sm)' }}>Em uso (aparece ao montar o orçamento)</span>
        </label>
      </div>
    </Modal>
  )
}
