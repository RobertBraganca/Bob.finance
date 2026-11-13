/**
 * Períodos do seletor de datas de Investimentos e da Evolução do patrimônio:
 * a mesma lista nas duas telas.
 */
export type RangePreset = 'since_start' | '12m' | '2y' | '5y' | '10y' | 'custom'

export const RANGE_PRESET_OPTIONS: Array<{ value: RangePreset; label: string }> = [
  { value: 'since_start', label: 'Desde o início' },
  { value: '12m', label: '12 meses' },
  { value: '2y', label: '2 anos' },
  { value: '5y', label: '5 anos' },
  { value: '10y', label: '10 anos' },
  { value: 'custom', label: 'Data personalizada' },
]

export const RANGE_PRESET_MONTHS: Partial<Record<RangePreset, number>> = { '12m': 12, '2y': 24, '5y': 60, '10y': 120 }
