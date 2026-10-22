import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Button, Card, ConfirmDeleteModal, EmptyState, SkeletonLines, useToast } from '../../components/ui'
import { PageHeader } from '../../components/shell/Shell'

type GoogleStatus = { configured: boolean; connected: boolean; email: string | null; lastSyncAt: string | null; lastError: string | null; events: number }

const STATE_KEY = 'bob-google-oauth-state'
/** Sincroniza sozinho ao abrir Tarefas se a última vez foi há mais que isto. */
const AUTO_SYNC_MS = 6 * 60 * 60 * 1000

const fmt = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

/**
 * Google Agenda (docs/specs/tarefas-comercial-contador, fase 3): conectar a
 * conta, ver quando sincronizou e desconectar. Cada tarefa aberta vira um
 * evento às 9h do dia, com lembrete; marcar como feita tira o evento.
 */
export function GoogleCalendarCard() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [disconnecting, setDisconnecting] = useState(false)
  const status = useQuery({ queryKey: ['tasks', 'google'], queryFn: () => api.get<GoogleStatus>('/google/status') })

  const connect = useMutation({
    mutationFn: async () => {
      const state = crypto.randomUUID()
      sessionStorage.setItem(STATE_KEY, state)
      return api.post<{ url: string }>('/google/auth-url', { state })
    },
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao abrir o Google', 'error'),
  })
  const sync = useMutation({
    mutationFn: () => api.post<{ created: number; updated: number; removed: number }>('/google/sync', {}),
    onSuccess: (r) => {
      toast(r.created + r.updated + r.removed === 0 ? 'Agenda já estava em dia' : `Agenda em dia: ${r.created} criados, ${r.updated} atualizados, ${r.removed} removidos`)
      queryClient.invalidateQueries({ queryKey: ['tasks', 'google'] })
    },
    onError: (error) => {
      toast(error instanceof Error ? error.message : 'falha ao sincronizar', 'error')
      queryClient.invalidateQueries({ queryKey: ['tasks', 'google'] })
    },
  })
  const disconnect = useMutation({
    mutationFn: () => api.del('/google/connection'),
    onSuccess: () => {
      toast('Google Agenda desconectado')
      setDisconnecting(false)
      queryClient.invalidateQueries({ queryKey: ['tasks', 'google'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao desconectar', 'error'),
  })

  // Sincroniza ao abrir a tela, no máximo a cada 6 horas.
  const autoSynced = useRef(false)
  const s = status.data
  useEffect(() => {
    if (!s?.connected || autoSynced.current || sync.isPending) return
    if (s.lastSyncAt && Date.now() - Date.parse(s.lastSyncAt) < AUTO_SYNC_MS) return
    autoSynced.current = true
    sync.mutate()
  }, [s, sync])

  return (
    <Card title="Google Agenda" subtitle="Cada tarefa aberta vira um evento às 9h do dia, com lembrete na hora e um dia antes">
      {status.isError ? (
        <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Não foi possível ler a conexão agora.</p>
      ) : !s ? (
        <SkeletonLines lines={2} />
      ) : !s.configured ? (
        <EmptyState
          icon="calendar"
          title="Falta configurar o acesso ao Google"
          body="É um passo único no Google Cloud (um cliente OAuth) e três variáveis no servidor. O passo a passo está no estudo das tarefas."
        />
      ) : !s.connected ? (
        <div className="row row--between row--wrap" style={{ gap: 'var(--sp-3)' }}>
          <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Conecte sua conta para as tarefas aparecerem na sua agenda.</p>
          <Button variant="primary" icon="calendar" onClick={() => connect.mutate()} loading={connect.isPending}>
            Conectar Google Agenda
          </Button>
        </div>
      ) : (
        <div className="stack">
          <div className="row row--between row--wrap" style={{ gap: 'var(--sp-3)' }}>
            <span style={{ fontSize: 'var(--text-sm)' }}>
              Conectado{s.email ? ` como ${s.email}` : ''} · {s.events === 1 ? '1 evento' : `${s.events} eventos`}
              <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                {s.lastSyncAt ? `Última sincronização ${fmt(s.lastSyncAt)}` : 'Ainda não sincronizou'}
              </span>
            </span>
            <span className="row" style={{ gap: 'var(--sp-2)' }}>
              <Button icon="refresh" onClick={() => sync.mutate()} loading={sync.isPending}>
                Sincronizar agora
              </Button>
              <Button variant="quiet" onClick={() => setDisconnecting(true)}>
                Desconectar
              </Button>
            </span>
          </div>
          {s.lastError && <p className="field__error" style={{ margin: 0 }}>Última tentativa: {s.lastError}</p>}
        </div>
      )}
      {disconnecting && (
        <ConfirmDeleteModal
          title="Desconectar o Google Agenda?"
          body="Os eventos que o app criou saem da sua agenda e o acesso é revogado no Google. As tarefas continuam aqui."
          confirmLabel="Desconectar"
          pending={disconnect.isPending}
          onCancel={() => setDisconnecting(false)}
          onConfirm={() => disconnect.mutate()}
        />
      )}
    </Card>
  )
}

/**
 * Para onde o Google devolve depois do consentimento (`/tarefas/google`): confere
 * o `state` guardado antes de sair e manda o código ao servidor com a sessão.
 */
export function GoogleCallbackPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const queryClient = useQueryClient()
  const ran = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    const params = new URLSearchParams(window.location.search)
    const expected = sessionStorage.getItem(STATE_KEY)
    sessionStorage.removeItem(STATE_KEY)
    if (params.get('error')) return setError('O acesso foi recusado no Google.')
    const code = params.get('code')
    if (!code || !expected || params.get('state') !== expected) return setError('O retorno do Google não confere com o pedido. Tente conectar de novo.')
    api
      .post('/google/connect', { code })
      .then(() => {
        toast('Google Agenda conectado')
        queryClient.invalidateQueries({ queryKey: ['tasks'] })
        navigate('/tarefas', { replace: true })
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'falha ao conectar'))
  }, [navigate, queryClient, toast])

  return (
    <>
      <PageHeader title="Google Agenda" />
      <div className="page">
        <Card>
          {error ? (
            <EmptyState
              icon="alert"
              title="Não deu para conectar"
              body={error}
              action={<Button onClick={() => navigate('/tarefas', { replace: true })}>Voltar para Tarefas</Button>}
            />
          ) : (
            <SkeletonLines lines={2} />
          )}
        </Card>
      </div>
    </>
  )
}
