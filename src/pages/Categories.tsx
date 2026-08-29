import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useCategories, type CategoryNode } from '../lib/store'
import {
  Button,
  Card,
  CategorySelect,
  EmptyState,
  Icon,
  Select,
  Slab,
  StatTile,
  useToast,
} from '../components/ui'
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs'
import { PageHeader } from '../components/shell/Shell'

/**
 * The brand's own 4 categorical hues — the full set BOB.OS provides
 * outside red/yellow, which are reserved for status. A parent picks one
 * of these.
 */
const PALETTE = [
  { hex: '#007bff', name: 'azul' },
  { hex: '#ff2ea6', name: 'rosa' },
  { hex: '#1e8e3c', name: 'verde' },
  { hex: '#ba2be2', name: 'roxo' },
]

const KIND_LABEL: Record<string, string> = {
  income: 'Receita',
  expense: 'Despesa',
  transfer: 'Transferência',
  investment: 'Investimento',
}

type Rule = {
  id: number
  categoryId: number
  categoryPath: string
  color: string
  field: string
  matchType: string
  pattern: string
  direction: string
  priority: number
  origin: string
  hitCount: number
  active: number
}

type Memory = {
  signature: string
  categoryPath: string
  color: string
  hits: number
  promotedRuleId: number | null
  lastSeenAt: string
}

export function CategoriesPage() {
  const [tab, setTab] = useState<'tree' | 'rules' | 'memory'>('tree')
  const toast = useToast()
  const queryClient = useQueryClient()

  const rules = useQuery({
    queryKey: ['rules'],
    queryFn: () => api.get<{ rules: Rule[]; memory: Memory[] }>('/rules'),
  })

  const recategorize = useMutation({
    mutationFn: (onlyUncategorized: boolean) =>
      api.post<{ scanned: number; updated: number }>('/rules/recategorize', { onlyUncategorized }),
    onSuccess: (result) => {
      toast(`${result.updated} de ${result.scanned} lançamentos recategorizados`)
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao recategorizar', 'error'),
  })

  return (
    <>
      <PageHeader
        title="Categorias e regras"
        subtitle="A árvore, as regras que categorizam sozinhas e o que o app aprendeu com você"
        actions={
          <div className="row">
            <Button icon="refresh" onClick={() => recategorize.mutate(true)} disabled={recategorize.isPending}>
              Aplicar às sem categoria
            </Button>
            <Button
              variant="ghost"
              icon="sparkle"
              onClick={() => recategorize.mutate(false)}
              disabled={recategorize.isPending}
              title="Reaplica as regras a tudo, preservando atribuições manuais"
            >
              Reaplicar a tudo
            </Button>
          </div>
        }
      />

      <div className="page">
        <Tabs value={tab} onValueChange={(value) => setTab(value as 'tree' | 'rules' | 'memory')}>
          <TabsList aria-label="Seção">
            <TabsTrigger value="tree">Árvore</TabsTrigger>
            <TabsTrigger value="rules">{`Regras (${rules.data?.rules.length ?? 0})`}</TabsTrigger>
            <TabsTrigger value="memory">{`Aprendizado (${rules.data?.memory.length ?? 0})`}</TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === 'tree' && <CategoryTree />}
        {tab === 'rules' && <RulesTable rules={rules.data?.rules ?? []} isError={rules.isError} />}
        {tab === 'memory' && <MemoryTable memory={rules.data?.memory ?? []} isError={rules.isError} />}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Tree
 * ------------------------------------------------------------------ */
function CategoryTree() {
  const { data } = useCategories()
  const [editing, setEditing] = useState<CategoryNode | null>(null)
  const [addingUnder, setAddingUnder] = useState<CategoryNode | null | 'root'>(null)

  const tree = data?.tree ?? []
  const grouped = ['income', 'expense', 'transfer', 'investment'].map((kind) => ({
    kind,
    nodes: tree.filter((node) => node.kind === kind),
  }))

  return (
    <>
      <div className="row row--between">
        <p className="muted" style={{ fontSize: 'var(--text-sm)', maxWidth: '70ch' }}>
          Uma subcategoria herda a cor e o tipo da categoria-mãe: o gráfico de rosca agrupa por
          mãe, então uma filha com cor própria reportaria o grupo errado.
        </p>
        <Button variant="primary" icon="plus" onClick={() => setAddingUnder('root')}>
          Nova categoria-mãe
        </Button>
      </div>

      <div className="bento">
        {grouped.map((group) =>
          group.nodes.length === 0 ? null : (
            <Card key={group.kind} span={6} title={KIND_LABEL[group.kind]}>
              <div className="stack">
                {group.nodes.map((node) => (
                  <div key={node.id}>
                    <div className="row row--between" style={{ padding: '4px 0' }}>
                      <span className="row" style={{ gap: 'var(--sp-3)', minWidth: 0 }}>
                        <span className="swatch" style={{ background: node.color, width: 12, height: 12 }} />
                        <strong className="truncate">{node.name}</strong>
                        <span className="muted tabular" style={{ fontSize: 'var(--text-2xs)' }}>
                          {node.transactionCount}
                        </span>
                      </span>
                      <span className="row" style={{ gap: 2 }}>
                        <Button variant="quiet" size="sm" icon="pencil" onClick={() => setEditing(node)} title="Editar" />
                        <Button variant="quiet" size="sm" icon="plus" onClick={() => setAddingUnder(node)} title="Adicionar subcategoria" />
                      </span>
                    </div>
                    <div style={{ paddingLeft: 24 }}>
                      {node.children.map((child) => (
                        <div key={child.id} className="row row--between" style={{ padding: '2px 0' }}>
                          <span className="row" style={{ gap: 'var(--sp-3)', minWidth: 0 }}>
                            <span
                              className="dot"
                              style={{ background: child.color, opacity: 0.55, width: 6, height: 6 }}
                            />
                            <span className="truncate" style={{ fontSize: 'var(--text-sm)' }}>
                              {child.name}
                            </span>
                            <span className="muted tabular" style={{ fontSize: 'var(--text-2xs)' }}>
                              {child.transactionCount}
                            </span>
                          </span>
                          <Button
                            variant="quiet"
                            size="sm"
                            icon="pencil"
                            onClick={() => setEditing(child)}
                            title="Editar"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ),
        )}
      </div>

      {editing && <CategoryModal node={editing} onClose={() => setEditing(null)} />}
      {addingUnder !== null && (
        <CategoryModal
          parent={addingUnder === 'root' ? null : addingUnder}
          onClose={() => setAddingUnder(null)}
        />
      )}
    </>
  )
}

function CategoryModal({
  node,
  parent,
  onClose,
}: {
  node?: CategoryNode
  parent?: CategoryNode | null
  onClose: () => void
}) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const isEdit = node !== undefined
  const [name, setName] = useState(node?.name ?? '')
  const [color, setColor] = useState(node?.color ?? parent?.color ?? PALETTE[0]!.hex)
  const [kind, setKind] = useState(node?.kind ?? parent?.kind ?? 'expense')

  const isChild = isEdit ? node!.parentId !== null : parent !== null

  const save = useMutation({
    mutationFn: () =>
      isEdit
        ? api.patch(`/categories/${node!.id}`, { name, color, kind })
        : api.post('/categories', { name, color, kind, parentId: parent?.id ?? null }),
    onSuccess: () => {
      toast(isEdit ? 'Categoria atualizada' : 'Categoria criada')
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const remove = useMutation({
    mutationFn: () => api.del<{ archived: boolean; deleted: boolean; affected: number }>(`/categories/${node!.id}`),
    onSuccess: (result) => {
      toast(
        result.deleted
          ? 'Categoria excluída'
          : `Categoria arquivada, ${result.affected} lançamentos mantêm a classificação`,
      )
      queryClient.invalidateQueries()
      onClose()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao excluir', 'error'),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[560px]">
        <DialogTitle>
          {isEdit ? `Editar ${node!.name}` : parent ? `Nova subcategoria de ${parent.name}` : 'Nova categoria-mãe'}
        </DialogTitle>
      <div className="stack">
        <div className="field">
          <label className="field__label">Nome</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Assinaturas" />
        </div>

        {!isChild && (
          <>
            <div className="field">
              <label className="field__label">Tipo de fluxo</label>
              <Select
                value={kind}
                options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))}
                onChange={(value) => setKind(value ?? 'expense')}
              />
              <span className="field__hint">
                Transferências e investimentos ficam fora do cálculo de entradas e saídas.
              </span>
            </div>

            <div className="field">
              <label className="field__label">Cor do grupo</label>
              <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                {PALETTE.map((swatch) => (
                  <button
                    key={swatch.hex}
                    type="button"
                    onClick={() => setColor(swatch.hex)}
                    aria-label={swatch.name}
                    aria-pressed={color === swatch.hex}
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 'var(--r-sm)',
                      background: swatch.hex,
                      boxShadow: color === swatch.hex ? '0 0 0 2px var(--ink-1)' : 'none',
                    }}
                  />
                ))}
              </div>
              <span className="field__hint">
                São as 4 cores da identidade visual, validadas para daltonismo. Vermelho e amarelo
                ficam de fora por já serem usados em alertas de status; grupos além dessas 4
                viram “Outras” nos gráficos.
              </span>
            </div>
          </>
        )}

        {isChild && (
          <p className="field__hint">
            Subcategorias herdam cor e tipo da mãe automaticamente.
          </p>
        )}
      </div>
        <DialogFooter>
          {isEdit ? (
            <Button variant="danger" icon="trash" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Excluir
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */
const MATCH_LABEL: Record<string, string> = {
  contains: 'contém',
  starts_with: 'começa com',
  equals: 'é igual a',
  regex: 'regex',
}

function RulesTable({ rules, isError }: { rules: Rule[]; isError?: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [pattern, setPattern] = useState('')
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [matchType, setMatchType] = useState('contains')

  const create = useMutation({
    mutationFn: () => api.post('/rules', { pattern: pattern.trim(), categoryId, matchType }),
    onSuccess: () => {
      toast('Regra criada')
      setCreating(false)
      setPattern('')
      setCategoryId(null)
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao criar', 'error'),
  })

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/rules/${id}`),
    onSuccess: () => {
      toast('Regra removida')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover', 'error'),
  })

  return (
    <>
      <div className="bento">
        <Slab span={4}>
          <StatTile label="Regras ativas" value={rules.filter((r) => r.active).length} large />
        </Slab>
        <Slab span={4}>
          <StatTile label="Criadas por você" value={rules.filter((r) => r.origin === 'user').length} large />
        </Slab>
        <Slab span={4}>
          <StatTile
            label="Aprendidas de correções"
            value={rules.filter((r) => r.origin === 'learned').length}
            large
          />
        </Slab>

        <Card
          span={12}
          flush
          title="Regras"
          subtitle="Avaliadas da menor prioridade numérica para a maior: a primeira que casa ganha"
          actions={
            <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)}>
              Nova regra
            </Button>
          }
        >
          {isError ? (
            <EmptyState
              icon="alert"
              title="Falha ao carregar regras"
              body="Não foi possível carregar as regras agora. Tente novamente em instantes."
            />
          ) : rules.length === 0 ? (
            <EmptyState icon="tags" title="Nenhuma regra" body="Crie regras para categorizar automaticamente." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 70, textAlign: 'right' }}>Prior.</th>
                    <th style={{ width: 110 }}>Condição</th>
                    <th>Padrão</th>
                    <th>Categoria</th>
                    <th style={{ width: 110 }}>Origem</th>
                    <th style={{ width: 70, textAlign: 'right' }}>Usos</th>
                    <th style={{ width: 44 }} />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <tr key={rule.id}>
                      <td className="table__num muted">{rule.priority}</td>
                      <td className="muted">{MATCH_LABEL[rule.matchType] ?? rule.matchType}</td>
                      <td>
                        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
                          {rule.pattern}
                        </code>
                      </td>
                      <td>
                        <span className="row" style={{ gap: 'var(--sp-2)' }}>
                          <span className="swatch" style={{ background: rule.color }} />
                          <span className="truncate">{rule.categoryPath}</span>
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${rule.origin === 'learned' ? 'badge--info' : ''}`}>
                          {rule.origin === 'learned' ? 'aprendida' : 'sua'}
                        </span>
                      </td>
                      <td className="table__num">{rule.hitCount}</td>
                      <td>
                        <Button
                          variant="quiet"
                          size="sm"
                          icon="trash"
                          onClick={() => remove.mutate(rule.id)}
                          title="Remover regra"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {creating && (
        <Dialog open onOpenChange={(open) => !open && setCreating(false)}>
          <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[560px]">
            <DialogTitle>Nova regra</DialogTitle>
            <div className="stack">
              <div className="field">
                <label className="field__label">Condição na descrição</label>
                <Select
                  value={matchType}
                  options={Object.entries(MATCH_LABEL).map(([value, label]) => ({ value, label }))}
                  onChange={(value) => setMatchType(value ?? 'contains')}
                />
              </div>
              <div className="field">
                <label className="field__label">Padrão</label>
                <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="ex. uber" />
                <span className="field__hint">
                  A comparação ignora acentos e maiúsculas: “Padaria” casa com “PADARIA”.
                </span>
              </div>
              <div className="field">
                <label className="field__label">Categoria</label>
                <CategorySelect value={categoryId} placeholder="Escolha" onChange={setCategoryId} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="quiet" onClick={() => setCreating(false)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                icon="check"
                disabled={!pattern.trim() || categoryId === null || create.isPending}
                onClick={() => create.mutate()}
              >
                Criar
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Learned memory — auditable on purpose.
 * ------------------------------------------------------------------ */
function MemoryTable({ memory, isError }: { memory: Memory[]; isError?: boolean }) {
  const toast = useToast()
  const queryClient = useQueryClient()

  const forget = useMutation({
    mutationFn: (signature: string) => api.del(`/rules/memory/${encodeURIComponent(signature)}`),
    onSuccess: () => {
      toast('Aprendizado esquecido')
      queryClient.invalidateQueries()
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao esquecer', 'error'),
  })

  return (
    <Card
      flush
      title="O que o app aprendeu"
      subtitle="Cada correção manual conta um ponto para o comerciante. Na terceira confirmação, vira regra."
    >
      {isError ? (
        <EmptyState
          icon="alert"
          title="Falha ao carregar aprendizado"
          body="Não foi possível carregar o que o app aprendeu agora. Tente novamente em instantes."
        />
      ) : memory.length === 0 ? (
        <EmptyState
          icon="sparkle"
          title="Nada aprendido ainda"
          body="Corrija a categoria de um lançamento e o padrão aparece aqui."
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Assinatura do comerciante</th>
                <th>Categoria</th>
                <th style={{ width: 130, textAlign: 'right' }}>Confirmações</th>
                <th style={{ width: 120 }}>Status</th>
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {memory.map((entry) => (
                <tr key={entry.signature}>
                  <td>
                    <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
                      {entry.signature}
                    </code>
                  </td>
                  <td>
                    <span className="row" style={{ gap: 'var(--sp-2)' }}>
                      <span className="swatch" style={{ background: entry.color }} />
                      <span className="truncate">{entry.categoryPath}</span>
                    </span>
                  </td>
                  <td className="table__num">
                    <span className="progress-dots" style={{ justifyContent: 'flex-end' }}>
                      {[1, 2, 3].map((step) => (
                        <span
                          key={step}
                          className="progress-dots__dot"
                          style={{
                            background: entry.hits >= step ? 'var(--status-good)' : 'var(--paper-sunken)',
                            color: entry.hits >= step ? '#fff' : 'var(--ink-4)',
                          }}
                        >
                          {entry.hits >= step ? '✓' : step}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td>
                    {entry.promotedRuleId !== null ? (
                      <span className="badge badge--good">
                        <Icon name="check" size={11} strokeWidth={2.4} />
                        virou regra
                      </span>
                    ) : (
                      <span className="badge">sugerindo</span>
                    )}
                  </td>
                  <td>
                    <Button
                      variant="quiet"
                      size="sm"
                      icon="trash"
                      onClick={() => forget.mutate(entry.signature)}
                      title="Esquecer"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
