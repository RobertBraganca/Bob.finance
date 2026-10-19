import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Icon } from '../ui'
import { Skeleton } from '../ui/skeleton'
import type { CardEdit } from '../../lib/assistantApi'
import { ProposalCardView } from './ProposalCardView'
import type { ChatItem, ProposalBlock, ProposalState, useAssistantChat } from './useAssistantChat'

type Chat = ReturnType<typeof useAssistantChat>

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })

/** Vira `true` quando a hora de expirar passa, sem recarregar nada. */
function useExpired(expiresAt: string | null): boolean {
  const [expired, setExpired] = useState(() => (expiresAt ? Date.parse(expiresAt) <= Date.now() : false))
  useEffect(() => {
    if (!expiresAt) return
    const remaining = Date.parse(expiresAt) - Date.now()
    if (remaining <= 0) {
      setExpired(true)
      return
    }
    const handle = window.setTimeout(() => setExpired(true), Math.min(remaining, 2 ** 31 - 1))
    return () => window.clearTimeout(handle)
  }, [expiresAt])
  return expired
}

const BLOCK_TEXT: Record<ProposalBlock | 'time', string> = {
  time: 'Esta proposta expirou (ela vale por 15 minutos). Nada foi gravado.',
  expired: 'Esta proposta expirou. Nada foi gravado.',
  not_found: 'Não encontrei mais esta proposta. Nada foi gravado.',
  already_applied: 'Esta proposta já foi aplicada.',
}

function Who({ children }: { children: ReactNode }) {
  return <span className="assistant-who">{children}</span>
}

/** Move o foco para um elemento que acabou de ser atualizado (o botão que o usuário clicou sumiu). */
function focusSoon(id: string) {
  window.requestAnimationFrame(() => document.getElementById(id)?.focus())
}

function ProposalView({
  itemId,
  sourceText,
  proposal,
  chat,
}: {
  itemId: string
  sourceText: string
  proposal: ProposalState
  chat: Chat
}) {
  const timeExpired = useExpired(proposal.expiresAt)
  const blocked = proposal.block ?? (timeExpired ? 'time' : null)
  const pendingIds = proposal.cards.map((card) => card.actionId).filter((id) => proposal.status[id] === 'pending')
  const anyApplying = proposal.cards.some((card) => proposal.status[card.actionId] === 'applying')
  const confirmMany = async (ids: string[]) => {
    await chat.confirm(itemId, ids)
    const first = ids[0]
    if (first) focusSoon(`assistant-card-${first}`)
  }

  return (
    <div className="assistant-proposal">
      {proposal.cards.map((card) => (
        <ProposalCardView
          key={card.actionId}
          card={card}
          status={proposal.status[card.actionId] ?? 'pending'}
          edit={proposal.edits[card.actionId] as CardEdit | undefined}
          locked={blocked !== null}
          onConfirm={() => void confirmMany([card.actionId])}
          onCancel={() => {
            chat.cancelCard(itemId, card.actionId)
            focusSoon(`assistant-card-${card.actionId}`)
          }}
          onSaveEdit={(edit) => {
            // O foco volta ao botão Editar do próprio card (ProposalCardView).
            chat.saveEdit(itemId, card.actionId, edit)
          }}
        />
      ))}

      {blocked && pendingIds.length > 0 && (
        <div className="assistant-alert">
          <p className="assistant-alert__text">
            <Icon name="clock" size={14} />
            <span>{BLOCK_TEXT[blocked]}</span>
          </p>
          <div className="assistant-actions">
            <Button icon="refresh" onClick={() => chat.resend(sourceText)} disabled={chat.thinking}>
              Reenviar a frase
            </Button>
          </div>
        </div>
      )}

      {!blocked && pendingIds.length > 1 && (
        <div className="assistant-actions">
          <Button variant="primary" icon="check" onClick={() => void confirmMany(pendingIds)} disabled={anyApplying}>
            Confirmar tudo ({pendingIds.length})
          </Button>
        </div>
      )}

      {!blocked && pendingIds.length > 0 && proposal.expiresAt && (
        <p className="assistant-meta">Nada é gravado sem o seu Confirmar. A proposta vale até {hhmm(proposal.expiresAt)}.</p>
      )}
    </div>
  )
}

function ItemView({ item, chat }: { item: ChatItem; chat: Chat }) {
  if (item.type === 'user') {
    return (
      <div className="assistant-msg assistant-msg--user">
        <div className="assistant-bubble assistant-bubble--user">
          <span className="sr-only">Você: </span>
          {item.text}
        </div>
      </div>
    )
  }

  if (item.type === 'reply') {
    return (
      <div className="assistant-msg">
        <Who>Assistente</Who>
        <div className="assistant-bubble assistant-bubble--assistant">{item.summary}</div>
        {item.proposal && (
          <ProposalView itemId={item.id} sourceText={item.sourceText} proposal={item.proposal} chat={chat} />
        )}
        {item.questions.map((question) => (
          <div key={question} className="assistant-bubble assistant-bubble--assistant assistant-bubble--question">
            <span className="sr-only">Pergunta: </span>
            {question}
          </div>
        ))}
        {item.questions.length > 0 && !item.proposal && (
          <p className="assistant-meta">Responda na caixa de texto abaixo. Nenhuma ação foi proposta e nada foi gravado.</p>
        )}
      </div>
    )
  }

  if (item.type === 'result') {
    const undone = item.undo === 'undone'
    const refused = item.undo === 'refused'
    return (
      <div className="assistant-msg">
        <Who>Assistente</Who>
        <section
          id={`assistant-result-${item.id}`}
          tabIndex={-1}
          aria-label="Resultado da aplicação"
          className={`assistant-alert ${undone || refused ? '' : 'assistant-alert--good'}`}
        >
          <p className="assistant-alert__text">
            <Icon name={undone ? 'arrowLeft' : 'check'} size={14} strokeWidth={2.4} />
            <span>
              <strong>{undone ? 'Desfeito.' : item.actionIds.length === 1 ? 'Gravado.' : `${item.actionIds.length} ações gravadas.`}</strong>{' '}
              {undone ? 'Os registros voltaram ao que eram.' : `Às ${hhmm(item.appliedAt)}.`}
            </span>
          </p>
          <ul className="assistant-alert__list">
            {item.titles.map((title) => (
              <li key={title} style={undone ? { textDecoration: 'line-through' } : undefined}>
                {title}
              </li>
            ))}
          </ul>
          {refused && (
            <p className="assistant-note assistant-note--bad">
              <Icon name="alert" size={14} />
              <span>Não dá para desfazer: um dos registros mudou depois de ser gravado. Ajuste direto na tela do registro.</span>
            </p>
          )}
          {(item.undo === 'available' || item.undo === 'undoing') && (
            <div className="assistant-actions">
              <Button
                icon="arrowLeft"
                loading={item.undo === 'undoing'}
                onClick={async () => {
                  await chat.undo(item.id)
                  focusSoon(`assistant-result-${item.id}`)
                }}
              >
                Desfazer
              </Button>
            </div>
          )}
        </section>
      </div>
    )
  }

  // erro
  return (
    <div className="assistant-msg">
      <Who>Assistente</Who>
      <div className="assistant-alert assistant-alert--error">
        <p className="assistant-alert__text">
          <Icon name="alert" size={14} />
          <span>{item.failure.message}</span>
        </p>
        {item.retryText && (
          <div className="assistant-actions">
            <Button icon="refresh" onClick={() => chat.retry(item.id, item.retryText!)} disabled={chat.thinking}>
              Tentar de novo
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function Thinking() {
  return (
    <div className="assistant-msg" aria-busy="true">
      <Who>Assistente</Who>
      <div className="assistant-bubble assistant-bubble--assistant assistant-bubble--pending">
        <span className="sr-only">O assistente está pensando…</span>
        <Skeleton className="h-3 w-full" aria-hidden="true" />
        <Skeleton className="h-3 w-3/4" aria-hidden="true" />
      </div>
    </div>
  )
}

const EXAMPLES = [
  'Receita da Loja Azul de R$ 750,00, 50% finais, pagamento previsto para dia 25.',
  'Gastei R$ 42,90 na padaria hoje.',
  'Registra no Diário um almoço de R$ 38,00.',
]

export function ChatThread({
  chat,
  onPick,
  threadRef,
}: {
  chat: Chat
  onPick: (text: string) => void
  threadRef: React.RefObject<HTMLDivElement | null>
}) {
  const { items, thinking } = chat
  const lastId = useRef<string | null>(null)

  // Rolagem: resposta nova começa pelo topo (para ler o antes e depois);
  // mensagem do usuário e "pensando" descem até o fim.
  useEffect(() => {
    const thread = threadRef.current
    if (!thread) return
    const last = items[items.length - 1]
    const key = last ? last.id : null
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const behavior: ScrollBehavior = reduced ? 'auto' : 'smooth'
    if (key !== lastId.current && last) {
      lastId.current = key
      if (last.type === 'reply' || last.type === 'result' || last.type === 'error') {
        const el = thread.querySelector<HTMLElement>(`[data-item="${last.id}"]`)
        if (el) {
          thread.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior })
          return
        }
      }
    }
    thread.scrollTo({ top: thread.scrollHeight, behavior })
  }, [items, thinking, threadRef])

  return (
    <div
      ref={threadRef}
      className="assistant-thread"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label="Conversa com o assistente"
      tabIndex={0}
    >
      {items.length === 0 && !thinking && (
        <div className="assistant-empty">
          <h3 className="assistant-empty__title">Escreva o que quer registrar</h3>
          <p>
            Eu acho a pendência certa, ajusto datas, anoto comentários e lanço receitas, despesas, entradas do Diário,
            aportes, compras e vendas de ativos. Mostro o que vai mudar e só grava quando você confirma. Registro e organizo,
            não aconselho.
          </p>
          <div className="assistant-suggest">
            <span className="assistant-who">Exemplos</span>
            {EXAMPLES.map((example) => (
              <button key={example} type="button" className="assistant-suggest__btn" onClick={() => onPick(example)}>
                {example}
              </button>
            ))}
          </div>
        </div>
      )}
      {items.map((item) => (
        <div key={item.id} data-item={item.id} className={`assistant-row${item.type === 'user' ? ' assistant-row--user' : ''}`}>
          <ItemView item={item} chat={chat} />
        </div>
      ))}
      {thinking && <Thinking />}
    </div>
  )
}
