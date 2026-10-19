import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, useToast } from '../ui'
import { useAssistantChat } from './useAssistantChat'
import './assistant.css'

/** O painel só baixa na primeira abertura; o botão fixo e a conversa ficam sempre montados. */
const loadDialog = () => import('./AssistantDialog')
const AssistantDialog = lazy(loadDialog)

/**
 * O painel baixa por `import()`: sem rede, o chunk falha e, sem isto, o erro
 * derrubaria o app inteiro (o botão fica fora do `RouteErrorBoundary`). Aqui
 * o painel fecha e um aviso explica; o botão continua pronto para tentar de novo.
 */
class DialogBoundary extends Component<{ children: ReactNode; onError: () => void }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch() {
    this.props.onError()
  }
  override render() {
    return this.state.failed ? null : this.props.children
  }
}

/** Atalho: Ctrl+K (⌘K no Mac), abre e fecha. Ctrl+B já é da barra lateral (ui/sidebar.tsx). */
export const ASSISTANT_SHORTCUT_LABEL = 'Ctrl+K'

/**
 * Botão fixo no canto + painel de conversa do assistente em linguagem natural
 * (docs/specs/assistente). Montado uma vez para todas as telas autenticadas
 * (App.tsx). A conversa e o rascunho vivem aqui, não no diálogo: fechar o
 * painel não apaga a sessão, só recarregar a página.
 */
export function AssistantPanel() {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [openCount, setOpenCount] = useState(0)
  const toast = useToast()
  const chat = useAssistantChat()
  const fabRef = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const wasOpen = useRef(false)

  const openPanel = useCallback(() => {
    // Quem tinha o foco (o botão, ou o campo onde o atalho foi apertado) o recebe de volta.
    const active = document.activeElement
    opener.current = active instanceof HTMLElement && active !== document.body ? active : fabRef.current
    setOpenCount((count) => count + 1)
    setOpen(true)
  }, [])
  const closePanel = useCallback(() => setOpen(false), [])

  // Devolve o foco ao fechar. Safari não foca botão ao clicar: nesse caso volta para o botão fixo.
  useEffect(() => {
    if (open) {
      wasOpen.current = true
      return
    }
    if (!wasOpen.current) return
    wasOpen.current = false
    const target = opener.current?.isConnected ? opener.current : fabRef.current
    target?.focus()
  }, [open])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      event.preventDefault()
      if (event.repeat) return
      if (open) closePanel()
      else openPanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, openPanel, closePanel])

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        className="assistant-fab"
        aria-label="Assistente"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="Control+K Meta+K"
        title={`Assistente (${ASSISTANT_SHORTCUT_LABEL})`}
        onPointerEnter={() => void loadDialog()}
        onFocus={() => void loadDialog()}
        onClick={() => (open ? closePanel() : openPanel())}
      >
        <Icon name="sparkle" size={20} />
        <span className="assistant-fab__label" aria-hidden="true">
          Assistente
        </span>
      </button>
      {open && (
        // `key` novo a cada abertura: depois de uma falha, a próxima tentativa remonta o painel.
        <DialogBoundary
          key={openCount}
          onError={() => {
            setOpen(false)
            toast('Não foi possível abrir o assistente. Confira a conexão e tente de novo.', 'error')
          }}
        >
          <Suspense fallback={null}>
            <AssistantDialog chat={chat} draft={draft} setDraft={setDraft} onClose={closePanel} />
          </Suspense>
        </DialogBoundary>
      )}
    </>
  )
}
