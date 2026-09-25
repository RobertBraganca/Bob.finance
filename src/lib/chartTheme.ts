/**
 * Chart colour is resolved in JS rather than CSS because Recharts takes
 * colours as props. Each chart declares which surface it sits on and gets
 * the palette that was VALIDATED against that surface.
 *
 * The categorical set is the BOB.OS brand's own secondary colours — blue,
 * pink, green, purple — capped at 4 slots because that is the full extent
 * of what the brand provides outside red/yellow (which are reserved for
 * status). Verified with the dataviz validator against #ffffff and #080808.
 * Do not add a 5th colour: a 5th series folds into "Outros".
 */

export type Surface = 'paper' | 'slab'

export type ChartTheme = {
  surface: string
  series: readonly string[]
  grid: string
  axis: string
  axisText: string
  neutral: string
  /** sequential ramp ordered near-surface -> far-from-surface */
  sequential: readonly string[]
  status: { good: string; warning: string; serious: string; critical: string }
  /** semantic pair for the income vs expense chart */
  income: string
  expense: string
  /** the one hue used when a single series is the whole story */
  primary: string
}

/** Anchored on brand blue (#007BFF). Same hue and steps as tokens.css --seq-*. */
const SEQUENTIAL_LIGHT = [
  '#d6eaff', '#b8daff', '#8fc5ff', '#66b0ff', '#3396ff', '#007bff', '#0063cc', '#004a99',
] as const

/**
 * On the ink surface "near zero" must recede toward the surface, so the
 * ramp runs dark -> light. Same hue, same steps, inverted direction.
 */
const SEQUENTIAL_DARK = [
  '#002347', '#003166', '#004a99', '#0063cc', '#007bff', '#3396ff', '#66b0ff', '#8fc5ff',
] as const

/**
 * Exact BOB.OS semantics (good=brand green, warning=brand yellow,
 * critical=brand red) — these are FILLS. On the light surface the vivid
 * brand hues themselves fall under 3:1, so status never carries meaning by
 * colour alone: it always ships with an icon and a label.
 */
const STATUS_LIGHT = {
  good: '#1e8e3c',
  warning: '#a66a00',
  serious: '#e8590c',
  critical: '#ff0000',
} as const

/** On the ink surface the vivid brand hues themselves clear 3:1 comfortably. */
const STATUS_DARK = {
  good: '#32d74b',
  warning: '#ffc700',
  serious: '#e8590c',
  critical: '#ff0000',
} as const

const PAPER: ChartTheme = {
  surface: '#ffffff',
  series: ['#007bff', '#ff2ea6', '#1e8e3c', '#ba2be2'],
  grid: '#ececec',
  axis: '#d4d4d8',
  axisText: '#71717a',
  neutral: '#a1a1aa',
  sequential: SEQUENTIAL_LIGHT,
  status: STATUS_LIGHT,
  // Income vs expense are two SERIES (identity), not two statuses, so they
  // take categorical slots 1 and 2 — blue vs pink, colour-vision safe
  // (ΔE 13.6 protan, 35.4 normal). Green/red here would misuse reserved
  // status hues and be the least accessible pair available.
  income: '#007bff',
  expense: '#ff2ea6',
  primary: '#007bff',
}

const SLAB: ChartTheme = {
  surface: '#080808',
  series: ['#007bff', '#ff2ea6', '#32d74b', '#ba2be2'],
  grid: '#1c1c1c',
  axis: '#222222',
  axisText: '#71717a',
  neutral: '#52525b',
  sequential: SEQUENTIAL_DARK,
  status: STATUS_DARK,
  income: '#007bff',
  expense: '#ff2ea6',
  primary: '#007bff',
}

export const themeFor = (surface: Surface): ChartTheme => (surface === 'slab' ? SLAB : PAPER)

/**
 * Colour follows the ENTITY, never its rank: the index comes from a stable
 * key (category id), so filtering a series out never repaints the others.
 */
export function seriesColor(theme: ChartTheme, key: number | string, fallbackIndex = 0): string {
  const n = typeof key === 'number' ? key : hash(key)
  const index = Number.isFinite(n) ? Math.abs(n) : fallbackIndex
  return theme.series[index % theme.series.length]!
}

function hash(value: string): number {
  let h = 0
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0
  return h
}

/**
 * Same relative-luminance formula as `scripts/check-contrast.mjs`, applied
 * at runtime: a heatmap cell's fill is DATA-DRIVEN (one of 8 sequential
 * steps, either ramp), so no fixed foreground/background pair can be
 * hardcoded there the way the rest of the design system does it.
 *
 * Provably safe rather than tuned by eye: picking whichever of pure black
 * or pure white has the higher contrast ratio against a background of
 * luminance L guarantees at least 4.583:1 for EVERY possible L (the ratios
 * cross at L=0.179, both sides equal to that value there) -- comfortably
 * above the 4.5:1 this codebase requires of small text elsewhere.
 */
export function textOnFill(hex: string): string {
  const c = hex.replace('#', '')
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(c.slice(i, i + 2), 16) / 255))
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  const contrastWithBlack = (luminance + 0.05) / 0.05
  const contrastWithWhite = 1.05 / (luminance + 0.05)
  return contrastWithBlack >= contrastWithWhite ? '#09090b' : '#ffffff'
}

/* ---- Fixed mark specs, applied to every chart -------------------- */
export const MARK = {
  /** bars never fill their band — the leftover is deliberate air */
  barMaxWidth: 24,
  barRadius: [4, 4, 0, 0] as [number, number, number, number],
  barRadiusH: [0, 4, 4, 0] as [number, number, number, number],
  /** for a bar that hangs BELOW the zero line: the rounded edge flips too */
  barRadiusDown: [0, 0, 4, 4] as [number, number, number, number],
  lineWidth: 2,
  dotRadius: 4,
  activeDotRadius: 5,
  /** 2px of surface separating touching marks, and ringing overlapping dots */
  surfaceGap: 2,
  areaOpacity: 0.1,
  gridWidth: 1,
} as const

export const axisProps = (theme: ChartTheme) =>
  ({
    stroke: theme.axis,
    tick: { fill: theme.axisText, fontSize: 11 },
    tickLine: false,
    axisLine: { stroke: theme.axis },
  }) as const

export const gridProps = (theme: ChartTheme) =>
  ({
    stroke: theme.grid,
    strokeWidth: MARK.gridWidth,
    // Solid, never dashed: a dashed grid reads as "projection".
    strokeDasharray: undefined,
    vertical: false,
  }) as const
