import { Component, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button, EmptyState } from '../ui'

const RELOAD_FLAG = 'route-chunk-reload'

/** Arquivo da página que não baixou: típico logo depois de um deploy, quando os nomes dos arquivos mudam. */
function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message)
}

type Props = { children: ReactNode; resetKey: string }
type State = { error: unknown }

/**
 * Sem isto, qualquer erro ao abrir uma tela (inclusive o arquivo da página
 * que não baixou) desmontava o app inteiro: tela branca, sem menu, sem
 * mensagem (revisão beta de 30/09/2026). Aqui só a área da página cai, o
 * menu continua, e trocar de rota limpa o erro.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error }
  }

  override componentDidCatch(error: unknown) {
    // Uma recarga automática resolve o caso do deploy novo; a marca na sessão
    // evita laço de recarga se o arquivo continuar indisponível.
    if (isChunkLoadError(error) && !sessionStorage.getItem(RELOAD_FLAG)) {
      sessionStorage.setItem(RELOAD_FLAG, '1')
      window.location.reload()
    }
  }

  override componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  override render() {
    if (!this.state.error) return this.props.children
    const chunk = isChunkLoadError(this.state.error)
    return (
      <div className="page">
        <EmptyState
          icon="alert"
          title="Não foi possível abrir esta tela"
          body={
            chunk
              ? 'O app pode ter sido atualizado ou a conexão caiu. Recarregue a página para buscar a versão atual.'
              : 'Algo deu errado ao montar esta tela. Recarregue a página; se continuar, volte para a Visão geral.'
          }
          action={
            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              <Button
                variant="primary"
                icon="refresh"
                onClick={() => {
                  sessionStorage.removeItem(RELOAD_FLAG)
                  window.location.reload()
                }}
              >
                Recarregar
              </Button>
              <Link to="/" className="btn btn--ghost">
                Ir para a Visão geral
              </Link>
            </div>
          }
        />
      </div>
    )
  }
}

/** Rota coringa: antes, uma URL inexistente deixava a área principal vazia. */
export function NotFoundPage() {
  return (
    <div className="page">
      <EmptyState
        icon="search"
        title="Página não encontrada"
        body="Este endereço não existe no app. Use o menu ao lado ou volte para a Visão geral."
        action={
          <Link to="/" className="btn btn--primary">
            Ir para a Visão geral
          </Link>
        }
      />
    </div>
  )
}

/** Uma carga que chegou ao fim sem erro libera a próxima recarga automática. */
export function clearChunkReloadFlag() {
  sessionStorage.removeItem(RELOAD_FLAG)
}
