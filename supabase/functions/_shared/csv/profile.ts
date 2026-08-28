import { Buffer } from 'node:buffer'
import { z } from 'zod'
import { stripAccents } from '../core/normalize.ts'

/**
 * A parser profile is the complete description of one bank's CSV dialect,
 * stored as a database row. The import pipeline reads it; it never branches
 * on which bank a file came from. Adding a bank = inserting a row.
 */

const columnRef = z.union([z.string().min(1), z.number().int().nonnegative()])

export const columnMapSchema = z
  .object({
    date: columnRef,
    description: columnRef,
    amount: columnRef.optional(),
    debit: columnRef.optional(),
    credit: columnRef.optional(),
    typeFlag: columnRef.optional(),
    rawCategory: columnRef.optional(),
    docNumber: columnRef.optional(),
  })
  .strict()

export const signConventions = [
  'signed',
  'signed_inverted',
  'debit_credit',
  'type_flag',
] as const

export const profileConfigSchema = z.object({
  name: z.string().min(1),
  institution: z.string().min(1),
  delimiter: z.enum([',', ';', 'tab', '|', 'auto']).default(';'),
  encoding: z.enum(['utf-8', 'latin1', 'windows-1252']).default('utf-8'),
  dateFormat: z
    .enum(['dd/MM/yyyy', 'dd/MM/yy', 'dd-MM-yyyy', 'dd.MM.yyyy', 'yyyy-MM-dd', 'yyyy/MM/dd', 'auto'])
    .default('dd/MM/yyyy'),
  decimalSeparator: z.enum([',', '.']).default(','),
  thousandsSeparator: z.enum(['.', ',', '']).default('.'),
  signConvention: z.enum(signConventions).default('signed'),
  hasHeader: z.boolean().default(true),
  skipRows: z.number().int().min(0).max(50).default(0),
  columnMap: columnMapSchema,
  headerSignature: z.array(z.string()).default([]),
  ignorePatterns: z.array(z.string()).default([]),
  defaultAccountId: z.number().int().positive().nullable().optional(),
  active: z.boolean().default(true),
})

export type ColumnMap = z.infer<typeof columnMapSchema>
export type ProfileConfig = z.infer<typeof profileConfigSchema>
export type SignConvention = (typeof signConventions)[number]

export type ResolvedProfile = ProfileConfig & { id: number }

/** Validates that the column map can actually satisfy the sign convention. */
export function validateProfileShape(config: ProfileConfig): string[] {
  const problems: string[] = []
  const { columnMap: map, signConvention } = config

  if (signConvention === 'signed' || signConvention === 'signed_inverted') {
    if (map.amount === undefined) problems.push('columnMap.amount é obrigatório para esta convenção de sinal')
  }
  if (signConvention === 'debit_credit') {
    if (map.debit === undefined || map.credit === undefined) {
      problems.push('columnMap.debit e columnMap.credit são obrigatórios para debit_credit')
    }
  }
  if (signConvention === 'type_flag') {
    if (map.amount === undefined) problems.push('columnMap.amount é obrigatório para type_flag')
    if (map.typeFlag === undefined) problems.push('columnMap.typeFlag é obrigatório para type_flag')
  }
  if (config.decimalSeparator === config.thousandsSeparator) {
    problems.push('separador decimal e de milhar não podem ser iguais')
  }
  return problems
}

export const PAPA_DELIMITERS: Record<string, string> = {
  ',': ',',
  ';': ';',
  '|': '|',
  tab: '\t',
  auto: '',
}

/** Header comparison is accent- and case-insensitive; banks are inconsistent. */
export function headerKey(raw: string): string {
  return stripAccents(String(raw ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Guesses a file's encoding before any profile is known.
 *
 * Detection has to read the header row, and Brazilian banks still ship
 * latin1 exports with accented headers ("Histórico", "Crédito"). Decoding
 * those as UTF-8 turns every accent into U+FFFD, which silently breaks
 * header matching — so sniff first, then decode.
 */
export function sniffEncoding(buffer: Buffer): 'utf-8' | 'windows-1252' {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return 'utf-8'
  } catch {
    return 'windows-1252'
  }
}

/** Decodes an uploaded file buffer using the profile's declared encoding. */
export function decodeBuffer(buffer: Buffer, encoding: string): string {
  const label = encoding === 'latin1' ? 'windows-1252' : encoding
  let text: string
  try {
    text = new TextDecoder(label, { fatal: false }).decode(buffer)
  } catch {
    text = buffer.toString('utf8')
  }
  // Strip UTF-8 BOM — Excel-exported statements almost always carry one.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
