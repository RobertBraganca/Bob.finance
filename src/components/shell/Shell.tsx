import { NavLink, useLocation } from 'react-router-dom'
import { useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../ui/Icon'
import { FilterSelect } from '../ui'
import { PeriodPickerPopover } from '../ui/PeriodPickerPopover'
import {
  Sidebar as ShadcnSidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '../ui/sidebar'
import { useMeta, useRange } from '../../lib/store'
import { useTheme } from '../../lib/theme'
import { date as fmtDate } from '../../lib/format'
import logo from '../../assets/logo-red.svg'

type NavItem = { to: string; label: string; icon: IconName }
type NavSection = { label: string; items: NavItem[] }

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Acompanhar',
    items: [
      { to: '/', label: 'Visão geral', icon: 'dashboard' },
      { to: '/diario', label: 'Diário', icon: 'calendar' },
      { to: '/lancamentos', label: 'Lançamentos', icon: 'list' },
      { to: '/dre', label: 'DRE', icon: 'scale' },
    ],
  },
  {
    label: 'Planejar',
    items: [
      { to: '/saude', label: 'Saúde financeira', icon: 'sparkle' },
      { to: '/motor', label: 'Motor financeiro', icon: 'gauge' },
      { to: '/precificacao', label: 'Precificação', icon: 'calculator' },
      { to: '/metas', label: 'Metas do mês', icon: 'target' },
      { to: '/dividas', label: 'Endividamento', icon: 'landmark' },
      { to: '/investimentos', label: 'Investimentos', icon: 'trending' },
    ],
  },
]

/**
 * "Configurações" (specs/settings-accounts-profiles, "Reorganização da
 * navegação"): infraestrutura que se configura uma vez, não telas abertas
 * todo dia — reagrupada atrás de um item só em vez de competir por espaço
 * com o que o usuário usa no dia a dia. Nenhuma rota muda: cada `to` abaixo
 * é a mesma URL de sempre, inclusive `/cartoes`, que só sai da lista de
 * primeiro nível — segue existindo e navegável normalmente.
 */
const SETTINGS_NAV: NavItem[] = [
  { to: '/ajustes', label: 'Contas e bancos', icon: 'bank' },
  { to: '/cartoes', label: 'Cartões', icon: 'wallet' },
  { to: '/categorias', label: 'Categorias e regras', icon: 'tags' },
  { to: '/importar', label: 'Importar', icon: 'upload' },
]

function isNavActive(pathname: string, to: string) {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`)
}

export function Sidebar() {
  const meta = useMeta()
  const location = useLocation()
  const uncategorized = meta.data?.ledger.count === 0 ? 0 : undefined
  const { setOpenMobile } = useSidebar()
  const { theme, toggle } = useTheme()
  const isDark = theme === 'dark'
  // Aberto por padrão se a rota atual já está em Configurações, ou se o
  // sinal de "comece aqui" (nenhum lançamento ainda) está ativo — do
  // contrário, começa fechado para não competir por espaço com o resto.
  const [settingsOpen, setSettingsOpen] = useState(
    () => SETTINGS_NAV.some((item) => location.pathname === item.to) || uncategorized === 0,
  )

  return (
    <ShadcnSidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <div className="flex items-center gap-2 overflow-hidden">
            <img src={logo} alt="BOB.OS" className="size-6 shrink-0" />
            <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">
              Finanças
            </span>
          </div>
          <SidebarTrigger className="group-data-[collapsible=icon]:hidden" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {NAV_SECTIONS.map((section) => (
          <SidebarGroup key={section.label}>
            <SidebarGroupLabel>{section.label}</SidebarGroupLabel>
            <SidebarMenu>
              {section.items.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    isActive={isNavActive(location.pathname, item.to)}
                    tooltip={item.label}
                    onClick={() => setOpenMobile(false)}
                    render={<NavLink to={item.to} end={item.to === '/'} />}
                  >
                    <Icon name={item.icon} size={16} />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}

        <SidebarGroup>
          <SidebarGroupLabel>Configurar</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Configurações"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((v) => !v)}
              >
                <Icon name="settings" size={16} />
                <span>Configurações</span>
              </SidebarMenuButton>
              {uncategorized === 0 && !settingsOpen && <SidebarMenuBadge>comece aqui</SidebarMenuBadge>}
              {settingsOpen && (
                <SidebarMenuSub>
                  {SETTINGS_NAV.map((item) => (
                    <SidebarMenuSubItem key={item.to}>
                      <SidebarMenuSubButton
                        isActive={location.pathname === item.to}
                        onClick={() => setOpenMobile(false)}
                        render={<NavLink to={item.to} />}
                      >
                        <Icon name={item.icon} size={16} />
                        <span>{item.label}</span>
                        {item.to === '/importar' && uncategorized === 0 && (
                          <span className="ml-auto text-[10px] text-sidebar-foreground/70">
                            comece aqui
                          </span>
                        )}
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  ))}
                </SidebarMenuSub>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip={isDark ? 'Usar tema claro' : 'Usar tema escuro'} onClick={toggle}>
              <Icon name={isDark ? 'sun' : 'moon'} size={16} />
              <span>{isDark ? 'Tema claro' : 'Tema escuro'}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="px-2 py-1 text-xs text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
          {meta.data?.ledger.count ? (
            <>
              <strong className="tabular-nums">{meta.data.ledger.count.toLocaleString('pt-BR')}</strong>{' '}
              lançamentos
              <br />
              {fmtDate(meta.data.ledger.min)} a {fmtDate(meta.data.ledger.max)}
            </>
          ) : (
            'Nenhum dado ainda'
          )}
        </div>
      </SidebarFooter>

      <SidebarRail />
    </ShadcnSidebar>
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
