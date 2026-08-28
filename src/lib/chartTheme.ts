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

/** Bucket a value onto the sequential ramp. Zero always means "no data". */
export function rampStep(theme: ChartTheme, value: number, max: number): string {
  if (value <= 0 || max <= 0) return theme.sequential[0]!
  const steps = theme.sequential.length - 1
  const index = Math.max(1, Math.min(steps, Math.ceil((value / max) * steps)))
  return theme.sequential[index]!
}

/**
 * Calendar-heatmap steps (e.g. spend per day): a day with no spend is
 * `theme.neutral`, flat and unambiguous — never the palest blue, which in a
 * grid this dense would read as "a little" instead of "none". Every day
 * that DID spend gets `rampStep`'s brand-blue ramp: this is a neutral
 * "more data" quantity (see `rampStep`'s own note), not a risk signal, so
 * it never borrows the status (green/yellow/red) tokens.
 */
export function heatmapStep(theme: ChartTheme, value: number, max: number): string {
  return value <= 0 || max <= 0 ? theme.neutral : rampStep(theme, value, max)
}

/** `heatmapStep`'s fixed legend, low -> high: neutral, then the same ramp steps `rampStep` can actually land on. */
export const heatmapScale = (theme: ChartTheme): readonly string[] => [theme.neutral, ...theme.sequential.slice(1)]

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
