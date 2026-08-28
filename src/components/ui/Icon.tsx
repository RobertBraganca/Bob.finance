/**
 * A small hand-rolled line-icon set. A dependency-free set keeps the icon
 * weight and stroke consistent with the rest of the chrome, which a generic
 * icon pack tends to fight.
 */
const PATHS: Record<string, string> = {
  dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  upload: 'M12 16V4M8 8l4-4 4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2',
  list: 'M4 6h16M4 12h16M4 18h10',
  tags: 'M4 8a2 2 0 012-2h5l9 9-6 6-9-9zM8.5 10.5h.01',
  calendar: 'M4 7a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2zM4 10h16M9 3v4M15 3v4',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 16a4 4 0 100-8 4 4 0 000 8zM12 13a1 1 0 100-2 1 1 0 000 2z',
  landmark: 'M4 21h16M5 21V10M19 21V10M9 21v-7M15 21v-7M3 10l9-6 9 6z',
  trending: 'M3 17l6-6 4 4 7-7M17 8h4v4',
  settings:
    'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 01-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2V21a2 2 0 01-4 0v-.1A1.7 1.7 0 006 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 003 13.6H3a2 2 0 010-4h.1A1.7 1.7 0 004.6 6L4.5 6a2 2 0 012.8-2.8l.1.1A1.7 1.7 0 0010 3V3a2 2 0 014 0v.1a1.7 1.7 0 002.9 1.2l.1-.1a2 2 0 112.8 2.8l-.1.1A1.7 1.7 0 0021 10.4H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z',
  wallet: 'M3 8a2 2 0 012-2h14a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 11h18M16 15h2',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  arrowUpRight: 'M7 17L17 7M9 7h8v8',
  arrowDownLeft: 'M17 7L7 17M15 17H7V9',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  check: 'M4 12l5 5L20 6',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 3l9 16H3zM12 9v5M12 17h.01',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v6M12 8h.01',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.5-4.5',
  trash: 'M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13',
  refresh: 'M20 12a8 8 0 11-2.3-5.7M20 4v4h-4',
  download: 'M12 4v12M8 12l4 4 4-4M4 20h16',
  file: 'M6 3h7l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1zM13 3v6h5',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z',
  bank: 'M6 4h12a2 2 0 012 2v3H4V6a2 2 0 012-2zM4 9v9a2 2 0 002 2h12a2 2 0 002-2V9M9 14h6',
  pencil: 'M4 20h4l11-11-4-4L4 16zM14 5l4 4',
  filter: 'M4 6h16M7 12h10M10 18h4',
  home: 'M4 11l8-7 8 7v8a1 1 0 01-1 1h-5v-6H10v6H5a1 1 0 01-1-1z',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  scale: 'M12 4v16M7 8h10M6 8l-3 6h6zM18 8l-3 6h6z',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
  moon: 'M20.5 14.5a8.5 8.5 0 11-9-13 7 7 0 009 13z',
  // Precificação tinha o mesmo "target" de Metas do mês — nada a ver com
  // preço. Calculadora de botões (pontos com cap redondo = "botão").
  calculator:
    'M5 3h14a1 1 0 011 1v16a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1zM7 7h10M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h.01M12 19h.01M16 19h.01',
  // Motor financeiro tinha o mesmo "scale" de DRE — um medidor encaixa
  // melhor em "motor/simulador" do que uma balança.
  gauge: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 13l3.5-4.5M12 13a1 1 0 100-2 1 1 0 000 2z',
  // Classe 'cash' tinha o mesmo "wallet" de Cartões (nav) e de 'funds'.
  banknote:
    'M3 6h18a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V7a1 1 0 011-1zM12 9a3 3 0 100 6 3 3 0 000-6zM6 9v.01M18 9v.01M6 15v.01M18 15v.01',
  // Classe 'funds' tinha o mesmo "wallet" de Cartões (nav) e de 'cash'.
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5',
  // Classe 'other' tinha o mesmo "tags" de Categorias e regras.
  dots: 'M5 12a1 1 0 102 0 1 1 0 00-2 0zM11 12a1 1 0 102 0 1 1 0 00-2 0zM17 12a1 1 0 102 0 1 1 0 00-2 0z',
  // Classe 'fixed_income' tinha o mesmo "bank" de Contas e bancos (nav).
  shield: 'M12 3l7 3v6c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V6z',
  // Classe 'etf_intl' caía no fallback genérico ("wallet") por falta de
  // entrada própria.
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c2.5 2.5 4 5.7 4 9s-1.5 6.5-4 9M12 3c-2.5 2.5-4 5.7-4 9s1.5 6.5 4 9',
  // Drag handle for reordering — six dots, two columns.
  grip: 'M8 7a1 1 0 102 0 1 1 0 00-2 0zM14 7a1 1 0 102 0 1 1 0 00-2 0zM8 12a1 1 0 102 0 1 1 0 00-2 0zM14 12a1 1 0 102 0 1 1 0 00-2 0zM8 17a1 1 0 102 0 1 1 0 00-2 0zM14 17a1 1 0 102 0 1 1 0 00-2 0z',
}

export type IconName = keyof typeof PATHS

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.6,
  className,
}: {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
}) {
  const d = PATHS[name]
  if (!d) return null
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  )
}
