import { useEffect, useId, useRef, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Button, Icon } from '../ui'
import { MAX_PHRASE_LENGTH } from './constants'
import { ChatThread } from './ChatThread'
import type { useAssistantChat } from './useAssistantChat'

type Chat = ReturnType<typeof useAssistantChat>

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Painel de conversa como diálogo modal: foco entra no campo de texto ao
 * abrir, Tab e Shift+Tab ciclam dentro dele, Esc fecha, e quem abriu recebe o
 * foco de volta (isso é feito por `AssistantPanel`, que sabe quem abriu).
 * Mesmo desenho de `Modal` (ui/index.tsx), mas lateral e com a rolagem da
 * página travada. Renderiza num portal para escapar de qualquer contexto de
 * empilhamento da tela.
 */
export default function AssistantDialog({
  chat,
  draft,
  setDraft,
  onClose,
}: {
  chat: Chat
  draft: string
  setDraft: (value: string) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const threadRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const titleId = useId()
  const fieldId = useId()
  const hintId = useId()
  const counterId = useId()

  useEffect(() => {
    fieldRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      // A edição de um cartão trata o próprio Esc (fecha só a edição).
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      // Foco fora do painel (um botão que sumiu, o corpo da página): volta para dentro.
      if (!active || !panel.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // O foco nunca fica na página de trás (clique no fundo, leitor de tela).
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const panel = panelRef.current
      if (panel && event.target instanceof Node && !panel.contains(event.target)) {
        // Avisos (toasts) ficam fora do painel de propósito: deixa o foco neles.
        if (event.target instanceof Element && event.target.closest('.toasts')) return
        fieldRef.current?.focus()
      }
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [])

  // O campo cresce com o texto, até um teto.
  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`
  }, [draft])

  const length = draft.length
  const remaining = MAX_PHRASE_LENGTH - length
  const counterTone =
    remaining <= 0 ? ' assistant-counter--full' : remaining <= 60 ? ' assistant-counter--near' : ''
  const canSend = draft.trim().length > 0 && !chat.thinking

  const submit = () => {
    if (!canSend) return
    const text = draft
    setDraft('')
    void chat.send(text)
    fieldRef.current?.focus()
  }

  const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter envia; Shift+Enter quebra a linha; Enter de composição (IME) não conta.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  return createPortal(
    <div className="assistant-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panelRef} className="assistant-panel assistant" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="assistant-head">
          <div>
            <h2 id={titleId} className="assistant-head__title">
              <Icon name="sparkle" size={18} />
              Assistente
            </h2>
            <p className="assistant-head__sub">Registra e organiza. Não aconselha.</p>
          </div>
          <Button variant="quiet" icon="x" onClick={onClose} title="Fechar o assistente" />
        </header>

        <ChatThread chat={chat} threadRef={threadRef} onPick={(text) => {
          setDraft(text)
          fieldRef.current?.focus()
        }} />

        {/* Mudanças dentro de itens que já existem (cancelar, editar, desfazer). */}
        <div className="sr-only" role="status" aria-live="polite">
          {chat.announcement}
        </div>

        <form
          className="assistant-composer"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <label htmlFor={fieldId} className="sr-only">
            Mensagem para o assistente
          </label>
          <textarea
            ref={fieldRef}
            id={fieldId}
            className="assistant-composer__field"
            rows={2}
            maxLength={MAX_PHRASE_LENGTH}
            value={draft}
            placeholder="Descreva o que quer registrar…"
            aria-describedby={`${hintId} ${counterId}`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onFieldKeyDown}
          />
          <div className="assistant-composer__foot">
            <div className="assistant-composer__hint">
              <span id={hintId} className="assistant-composer__keys">
                Enter envia · Shift+Enter quebra a linha
              </span>
              <span id={counterId} className={`assistant-counter${counterTone}`}>
                {length}/{MAX_PHRASE_LENGTH}
                <span className="sr-only"> caracteres usados, restam {remaining}</span>
              </span>
            </div>
            <Button variant="primary" type="submit" icon="send" disabled={!canSend}>
              Enviar
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}
