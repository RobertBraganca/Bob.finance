import { NavLink, useLocation } from 'react-router-dom'
import { useEffect, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../ui/Icon'
import { FilterSelect } from '../ui'
import { PeriodPickerPopover } from '../ui/PeriodPickerPopover'
import { useMeta, useRange } from '../../lib/store'
import { useTheme } from '../../lib/theme'
import { date as fmtDate } from '../../lib/format'
import logo from '../../assets/logo-red.svg'

const NAV: Array<{ to: string; label: string; icon: IconName; group?: string }> = [
  { to: '/', label: 'Visão geral', icon: 'dashboard', group: 'Acompanhar' },
  { to: '/diario', label: 'Diário', icon: 'calendar' },
  { to: '/lancamentos', label: 'Lançamentos', icon: 'list' },
  { to: '/dre', label: 'DRE', icon: 'scale' },
  { to: '/saude', label: 'Saúde financeira', icon: 'sparkle', group: 'Planejar' },
  { to: '/motor', label: 'Motor financeiro', icon: 'gauge' },
  { to: '/precificacao', label: 'Precificação', icon: 'calculator' },
  { to: '/metas', label: 'Metas do mês', icon: 'target' },
  { to: '/dividas', label: 'Endividamento', icon: 'landmark' },
  { to: '/investimentos', label: 'Investimentos', icon: 'trending' },
]

/**
 * "Configurações" (specs/settings-accounts-profiles, "Reorganização da
 * navegação"): infraestrutura que se configura uma vez, não telas abertas
 * todo dia — reagrupada atrás de um item só em vez de competir por espaço
 * com o que o usuário usa no dia a dia. Nenhuma rota muda: cada `to` abaixo
 * é a mesma URL de sempre, inclusive `/cartoes`, que só sai da lista de
 * primeiro nível — segue existindo e navegável normalmente.
 */
const SETTINGS_NAV: Array<{ to: string; label: string; icon: IconName }> = [
  { to: '/ajustes', label: 'Contas e bancos', icon: 'bank' },
  { to: '/cartoes', label: 'Cartões', icon: 'wallet' },
  { to: '/categorias', label: 'Categorias e regras', icon: 'tags' },
  { to: '/importar', label: 'Importar', icon: 'upload' },
]

const SIDEBAR_COLLAPSE_KEY = 'sidebar-collapsed'

function useSidebarCollapse() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1')

  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', collapsed ? '68px' : '232px')
  }, [collapsed])

  return {
    collapsed,
    toggle: () =>
      setCollapsed((current) => {
        const next = !current
        localStorage.setItem(SIDEBAR_COLLAPSE_KEY, next ? '1' : '0')
        return next
      }),
  }
}

export function Sidebar() {
  const meta = useMeta()
  const location = useLocation()
  const uncategorized = meta.data?.ledger.count === 0 ? 0 : undefined
  const { collapsed, toggle } = useSidebarCollapse()
  const [mobileOpen, setMobileOpen] = useState(false)
  // Aberto por padrão se a rota atual já está em Configurações, ou se o
  // sinal de "comece aqui" (nenhum lançamento ainda) está ativo — do
  // contrário, começa fechado para não competir por espaço com o resto.
  const [settingsOpen, setSettingsOpen] = useState(
    () => SETTINGS_NAV.some((item) => location.pathname === item.to) || uncategorized === 0,
  )

  return (
    <aside className="sidebar" data-collapsed={collapsed} data-mobile-open={mobileOpen}>
      <div className="sidebar__bar">
        <div className="brandmark">
          <span className="brandmark__glyph">
            <img src={logo} alt="BOB.OS" />
          </span>
          {!collapsed && <span className="brandmark__name">Finanças</span>}
        </div>

        <button
          type="button"
          className="sidebar__hamburger"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label={mobileOpen ? 'Fechar menu' : 'Abrir menu'}
          aria-expanded={mobileOpen}
        >
          <Icon name={mobileOpen ? 'x' : 'list'} size={20} />
        </button>
      </div>

      {mobileOpen && <div className="sidebar__backdrop" onClick={() => setMobileOpen(false)} />}

      <nav className="nav">
        {NAV.map((item) => (
          <div key={item.to}>
            {item.group && !collapsed && <div className="nav__group label">{item.group}</div>}
            <NavLink
              to={item.to}
              end={item.to === '/'}
              className="nav__item"
              title={collapsed ? item.label : undefined}
              onClick={() => setMobileOpen(false)}
            >
              {({ isActive }) => (
                <>
                  <span className="nav__icon" style={isActive ? { color: 'inherit' } : undefined}>
                    <Icon name={item.icon} size={16} />
                  </span>
                  <span className="grow truncate">{item.label}</span>
                  {item.to === '/importar' && uncategorized === 0 && (
                    <span className="nav__badge">comece aqui</span>
                  )}
                </>
              )}
            </NavLink>
          </div>
        ))}

        <div>
          {!collapsed && <div className="nav__group label">Configurar</div>}
          <button
            type="button"
            className="nav__item"
            title={collapsed ? 'Configurações' : undefined}
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <span className="nav__icon">
              <Icon name="settings" size={16} />
            </span>
            {!collapsed && (
              <>
                <span className="grow truncate">Configurações</span>
                {uncategorized === 0 && !settingsOpen && <span className="nav__badge">comece aqui</span>}
                <Icon name={settingsOpen ? 'chevronDown' : 'chevronRight'} size={14} />
              </>
            )}
          </button>

          {settingsOpen && !collapsed && (
            <div className="stack stack--tight" style={{ marginTop: 2 }}>
              {SETTINGS_NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className="nav__item"
                  style={{ paddingLeft: 'var(--sp-7)' }}
                  onClick={() => setMobileOpen(false)}
                >
                  {({ isActive }) => (
                    <>
                      <span className="nav__icon" style={isActive ? { color: 'inherit' } : undefined}>
                        <Icon name={item.icon} size={16} />
                      </span>
                      <span className="grow truncate">{item.label}</span>
                      {item.to === '/importar' && uncategorized === 0 && (
                        <span className="nav__badge">comece aqui</span>
                      )}
                    </>
                  )}
                </NavLink>
              ))}
              <ThemeToggle asNavItem />
            </div>
          )}
        </div>

        <div className="sidebar__foot sidebar__foot--in-nav">
          {meta.data?.ledger.count ? (
            <>
              <strong className="tabular">{meta.data.ledger.count.toLocaleString('pt-BR')}</strong>{' '}
              lançamentos
              <br />
              {fmtDate(meta.data.ledger.min)} a {fmtDate(meta.data.ledger.max)}
            </>
          ) : (
            'Nenhum dado ainda'
          )}
        </div>
      </nav>

      {/* Expandido, "Aparência" mora dentro de Configurações (acima); só
          quando a barra está recolhida — e a submenu não tem onde caber —
          este atalho isolado continua sendo o único caminho até o tema. */}
      {collapsed && <ThemeToggle collapsed={collapsed} />}

      <button
        type="button"
        className="sidebar__collapse-btn"
        onClick={toggle}
        title={collapsed ? 'Expandir menu' : 'Recolher menu'}
      >
        <Icon name="chevronRight" size={14} className={collapsed ? undefined : 'sidebar__collapse-icon'} />
        {!collapsed && <span>Recolher</span>}
      </button>

      {!collapsed && (
        <div className="sidebar__foot sidebar__foot--desktop">
          {meta.data?.ledger.count ? (
            <>
              <strong className="tabular">{meta.data.ledger.count.toLocaleString('pt-BR')}</strong>{' '}
              lançamentos
              <br />
              {fmtDate(meta.data.ledger.min)} a {fmtDate(meta.data.ledger.max)}
            </>
          ) : (
            'Nenhum dado ainda'
          )}
        </div>
      )}
    </aside>
  )
}

/** Dark mode reuses the already-validated ink-card palette at the root
 * (see tokens.css `:root[data-theme='dark']`) rather than a third,
 * uncalibrated colour set — so every `.card` converges toward `.slab`,
 * and only `.slab--accent` still stands apart. */
function ThemeToggle({ collapsed = false, asNavItem = false }: { collapsed?: boolean; asNavItem?: boolean }) {
  const { theme, toggle } = useTheme()
  const isDark = theme === 'dark'

  // "Aparência" dentro de Configurações (specs/settings-accounts-profiles,
  // "Reorganização da navegação") — mesmo controle, só com a mesma cara de
  // `.nav__item` dos outros itens do submenu em vez do atalho isolado do
  // rodapé.
  if (asNavItem) {
    return (
      <button
        type="button"
        className="nav__item"
        style={{ paddingLeft: 'var(--sp-7)' }}
        onClick={toggle}
        title={isDark ? 'Usar tema claro' : 'Usar tema escuro'}
      >
        <span className="nav__icon">
          <Icon name={isDark ? 'sun' : 'moon'} size={16} />
        </span>
        <span className="grow truncate">Aparência</span>
        <span className="muted" style={{ fontSize: 'var(--text-2xs)' }}>
          {isDark ? 'Escuro' : 'Claro'}
        </span>
      </button>
    )
  }

  return (
    <button
      type="button"
      className="sidebar__collapse-btn"
      onClick={toggle}
      title={isDark ? 'Usar tema claro' : 'Usar tema escuro'}
    >
      <Icon name={isDark ? 'sun' : 'moon'} size={14} />
      {!collapsed && <span>{isDark ? 'Tema claro' : 'Tema escuro'}</span>}
    </button>
  )
}

/**
 * ONE filter row, above everything it scopes. Changing it re-renders every
 * chart on the page against the same slice — never a filter inside a card.
 */
export function RangeFilter({ hideAccountFilter }: { hideAccountFilter?: boolean } = {}) {
  const range = useRange()
  const meta = useMeta()
  const accounts = meta.data?.accounts ?? []

  return (
    <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
      <PeriodPickerPopover
        preset={range.preset}
        from={range.from}
        to={range.to}
        anchor={range.anchor}
        onPreset={range.setPreset}
        onCustom={range.setCustom}
      />
      {!hideAccountFilter && (
        <FilterSelect
          icon="wallet"
          value={range.accountId}
          placeholder="Todas as contas"
          options={accounts.map((account) => ({ value: account.id, label: account.name }))}
          onChange={range.setAccountId}
        />
      )}
      <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
        {fmtDate(range.from)} a {fmtDate(range.to)}
      </span>
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="topbar">
      <div className="topbar__title">
        <h1 className="h1">{title}</h1>
        {subtitle && (
          <p className="muted" style={{ fontSize: 'var(--text-sm)', marginTop: 2 }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="topbar__actions">{actions}</div>}
    </header>
  )
}
