import {
  IconLayoutDashboardFilled,
  IconFileUploadFilled,
  IconListFilled,
  IconTagsFilled,
  IconCalendarFilled,
  IconTarget,
  IconBuildingMonument,
  IconTrendingUp,
  IconSettingsFilled,
  IconCreditCardFilled,
  IconChevronDownFilled,
  IconChevronRightFilled,
  IconCircleArrowUpRightFilled,
  IconCircleArrowDownLeftFilled,
  IconArrowBigRightFilled,
  IconPlusFilled,
  IconCheckFilled,
  IconXFilled,
  IconAlertTriangleFilled,
  IconInfoCircleFilled,
  IconSearchFilled,
  IconTrashFilled,
  IconRefresh,
  IconDownloadFilled,
  IconFileFilled,
  IconSparklesFilled,
  IconBuildingBank,
  IconPencilFilled,
  IconFilterFilled,
  IconHomeFilled,
  IconClockFilled,
  IconScaleFilled,
  IconSunFilled,
  IconMoonFilled,
  IconCalculatorFilled,
  IconGaugeFilled,
  IconCashBanknoteFilled,
  IconStack2Filled,
  IconDotsFilled,
  IconShieldFilled,
  IconWorldFilled,
  IconGripVertical,
  IconLogout,
  type Icon as TablerIcon,
} from '@tabler/icons-react'

/**
 * Tabler Icons, estilo filled (pedido do usuário, 29/08/2026) — a maior
 * parte troca direto para a variante `...Filled` da própria Tabler; onde
 * não existe uma variante filled (arrows/chevrons puramente lineares
 * ganham `IconArrowBigRightFilled`/`IconCircleArrow*Filled`, formas sem
 * versão preenchida alguma ficam documentadas abaixo), a escolha some no
 * comentário ao lado da entrada. Mesma assinatura de chamada de sempre
 * (`{name, size, strokeWidth, className}`), então nenhum dos ~150+
 * `<Icon name="..." />` call sites precisou mudar.
 */
const ICONS: Record<string, TablerIcon> = {
  dashboard: IconLayoutDashboardFilled,
  // Tabler não tem "upload" filled — o arquivo-com-seta-de-upload é o
  // equivalente preenchido mais próximo do glifo antigo.
  upload: IconFileUploadFilled,
  list: IconListFilled,
  tags: IconTagsFilled,
  calendar: IconCalendarFilled,
  // Sem "target" filled na Tabler — outline mantido de propósito, não é
  // um esquecimento (ver ADR 0031).
  target: IconTarget,
  // Landmark: nem outline nem filled existem com esse nome — mantém o
  // monumento de colunas de sempre, sem versão preenchida na Tabler.
  landmark: IconBuildingMonument,
  // Sem "trending" filled na Tabler — outline mantido.
  trending: IconTrendingUp,
  settings: IconSettingsFilled,
  // "wallet" não tem filled; o cartão preenchido encaixa igual ou melhor
  // nos dois lugares que usam esta chave (nav de Cartões, filtro de conta).
  wallet: IconCreditCardFilled,
  chevronDown: IconChevronDownFilled,
  chevronRight: IconChevronRightFilled,
  // Setas diagonais não têm filled — o badge circular preenchido com a
  // mesma seta é o equivalente da Tabler pra essa direção.
  arrowUpRight: IconCircleArrowUpRightFilled,
  arrowDownLeft: IconCircleArrowDownLeftFilled,
  arrowRight: IconArrowBigRightFilled,
  plus: IconPlusFilled,
  check: IconCheckFilled,
  x: IconXFilled,
  alert: IconAlertTriangleFilled,
  info: IconInfoCircleFilled,
  search: IconSearchFilled,
  trash: IconTrashFilled,
  // Sem "refresh"/rotate filled na Tabler — outline mantido.
  refresh: IconRefresh,
  download: IconDownloadFilled,
  file: IconFileFilled,
  sparkle: IconSparklesFilled,
  // Sem "bank" filled na Tabler — outline mantido.
  bank: IconBuildingBank,
  pencil: IconPencilFilled,
  filter: IconFilterFilled,
  home: IconHomeFilled,
  clock: IconClockFilled,
  scale: IconScaleFilled,
  sun: IconSunFilled,
  moon: IconMoonFilled,
  // Precificação tinha o mesmo "target" de Metas do mês — nada a ver com
  // preço. Calculadora encaixa melhor em "precificação".
  calculator: IconCalculatorFilled,
  // Motor financeiro tinha o mesmo "scale" de DRE — um medidor encaixa
  // melhor em "motor/simulador" do que uma balança.
  gauge: IconGaugeFilled,
  // Classe 'cash' tinha o mesmo "wallet" de Cartões (nav) e de 'funds'.
  // Sem "cash" filled — a cédula (banknote) preenchida é o equivalente.
  banknote: IconCashBanknoteFilled,
  // Classe 'funds' tinha o mesmo "wallet" de Cartões (nav) e de 'cash'.
  layers: IconStack2Filled,
  // Classe 'other' tinha o mesmo "tags" de Categorias e regras.
  dots: IconDotsFilled,
  // Classe 'fixed_income' tinha o mesmo "bank" de Contas e bancos (nav).
  shield: IconShieldFilled,
  // Classe 'etf_intl' caía no fallback genérico ("wallet") por falta de
  // entrada própria.
  globe: IconWorldFilled,
  // Drag handle for reordering — sem filled na Tabler, e não faria
  // diferença visual num ícone deste tamanho.
  grip: IconGripVertical,
  // Sem "logout" filled na Tabler — outline mantido (login/29/08/2026).
  logout: IconLogout,
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
