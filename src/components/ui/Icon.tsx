import {
  IconLayoutDashboard,
  IconUpload,
  IconList,
  IconTags,
  IconCalendar,
  IconTarget,
  IconBuildingMonument,
  IconTrendingUp,
  IconSettings,
  IconWallet,
  IconChevronDown,
  IconChevronRight,
  IconArrowUpRight,
  IconArrowDownLeft,
  IconArrowRight,
  IconPlus,
  IconCheck,
  IconX,
  IconAlertTriangle,
  IconInfoCircle,
  IconSearch,
  IconTrash,
  IconRefresh,
  IconDownload,
  IconFile,
  IconSparkles,
  IconBuildingBank,
  IconPencil,
  IconFilter,
  IconHome,
  IconClock,
  IconScale,
  IconSun,
  IconMoon,
  IconCalculator,
  IconGauge,
  IconCash,
  IconStack2,
  IconDots,
  IconShield,
  IconWorld,
  IconGripVertical,
  type Icon as TablerIcon,
} from '@tabler/icons-react'

/**
 * Tabler Icons (shadcn migration, Fase 0) — replaces a hand-rolled SVG set
 * that lived here before. Same call signature as always
 * (`{name, size, strokeWidth, className}`), so every one of the ~150+
 * `<Icon name="..." />` call sites across the app needed zero changes;
 * only this mapping is new. `strokeWidth` (this component's own prop
 * name, kept for that reason) maps to Tabler's own `stroke` prop.
 *
 * A few names here don't have a 1:1 Tabler glyph and were picked for
 * closest visual/semantic match to what they replace — same
 * disambiguation comments the old hand-rolled set already carried are
 * kept below where a name doesn't literally match its Tabler icon.
 */
const ICONS: Record<string, TablerIcon> = {
  dashboard: IconLayoutDashboard,
  upload: IconUpload,
  list: IconList,
  tags: IconTags,
  calendar: IconCalendar,
  target: IconTarget,
  // Landmark: a columned monument/government-building glyph — Tabler has
  // no icon literally named "landmark".
  landmark: IconBuildingMonument,
  trending: IconTrendingUp,
  settings: IconSettings,
  wallet: IconWallet,
  chevronDown: IconChevronDown,
  chevronRight: IconChevronRight,
  arrowUpRight: IconArrowUpRight,
  arrowDownLeft: IconArrowDownLeft,
  arrowRight: IconArrowRight,
  plus: IconPlus,
  check: IconCheck,
  x: IconX,
  alert: IconAlertTriangle,
  info: IconInfoCircle,
  search: IconSearch,
  trash: IconTrash,
  refresh: IconRefresh,
  download: IconDownload,
  file: IconFile,
  sparkle: IconSparkles,
  bank: IconBuildingBank,
  pencil: IconPencil,
  filter: IconFilter,
  home: IconHome,
  clock: IconClock,
  scale: IconScale,
  sun: IconSun,
  moon: IconMoon,
  // Precificação tinha o mesmo "target" de Metas do mês — nada a ver com
  // preço. Calculadora encaixa melhor em "precificação".
  calculator: IconCalculator,
  // Motor financeiro tinha o mesmo "scale" de DRE — um medidor encaixa
  // melhor em "motor/simulador" do que uma balança.
  gauge: IconGauge,
  // Classe 'cash' tinha o mesmo "wallet" de Cartões (nav) e de 'funds'.
  banknote: IconCash,
  // Classe 'funds' tinha o mesmo "wallet" de Cartões (nav) e de 'cash'.
  layers: IconStack2,
  // Classe 'other' tinha o mesmo "tags" de Categorias e regras.
  dots: IconDots,
  // Classe 'fixed_income' tinha o mesmo "bank" de Contas e bancos (nav).
  shield: IconShield,
  // Classe 'etf_intl' caía no fallback genérico ("wallet") por falta de
  // entrada própria.
  globe: IconWorld,
  // Drag handle for reordering.
  grip: IconGripVertical,
}

export type IconName = keyof typeof ICONS

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
  const Cmp = ICONS[name]
  if (!Cmp) return null
  return <Cmp size={size} stroke={strokeWidth} className={className} aria-hidden="true" />
}
