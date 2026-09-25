import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon, type IconName } from '../ui/Icon'
import { Assumptions, Button } from '../ui'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../ui/alert'
import { usePopoverDismiss } from '../ui/DateRangePopover'
import { useInsights, type InsightSeverity } from '../../lib/insights'

const BANNER_ICON: Record<InsightSeverity, IconName> = {
  good: 'check',
  warning: 'alert',
  critical: 'alert',
  neutral: 'clock',
}

/**
 * Sino de notificações: um ponto de entrada só, visível em toda tela (barra
 * superior), pros mesmos avisos que antes viviam soltos no topo do Painel
 * (revisão de 25/09/2026, a pedido do usuário — a pilha de `Alert`s
 * competia visualmente com o resto da tela mais visitada do produto).
 * Mesma fonte de dado de sempre (`useInsights`), zero fórmula nova: só o
 * LUGAR onde ela aparece mudou.
 */
export function NotificationsBell() {
  const { items, dismiss } = useInsights()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)

  usePopoverDismiss(open, anchorRef, () => setOpen(false))

  return (
    <div className="popover-anchor" ref={anchorRef}>
      <button
        type="button"
        className="btn btn--ghost btn--icon notifications-bell__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={items.length > 0 ? `Notificações, ${items.length} para revisar` : 'Notificações'}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="bell" size={17} />
        {items.length > 0 && (
          <span className="notifications-bell__badge">{items.length > 9 ? '9+' : items.length}</span>
        )}
      </button>
      {open && (
        <div className="popover-panel popover-panel--right notifications-bell__panel" role="dialog" aria-label="Notificações">
          <strong style={{ fontSize: 'var(--text-sm)' }}>Notificações</strong>
          {items.length === 0 ? (
            <p className="muted" style={{ fontSize: 'var(--text-xs)' }}>
              Nenhuma notificação agora.
            </p>
          ) : (
            <div className="stack stack--tight">
              {items.map((item) => (
                <Alert key={item.id} variant={item.severity === 'neutral' ? 'default' : item.severity}>
                  <Icon name={BANNER_ICON[item.severity]} size={16} />
                  <AlertTitle>{item.title}</AlertTitle>
                  <AlertDescription>
                    {item.description}
                    <Assumptions data={item.assumptions} compact />
                  </AlertDescription>
                  <AlertAction>
                    <div className="row" style={{ gap: 2 }}>
                      {item.linkTo && (
                        <Link to={item.linkTo} onClick={() => setOpen(false)}>
                          <Button variant="ghost" size="sm">
                            Ver
                          </Button>
                        </Link>
                      )}
                      <Button variant="ghost" size="sm" icon="x" title="Dispensar por hoje" onClick={() => dismiss(item.id)} />
                    </div>
                  </AlertAction>
                </Alert>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
