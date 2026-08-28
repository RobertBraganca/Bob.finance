import Papa from 'papaparse'
import { headerKey, type ResolvedProfile } from './profile.ts'

export type Detection = {
  profileId: number | null
  profileName: string | null
  score: number
  matched: string[]
  missing: string[]
  headers: string[]
  delimiter: string
  /** 0-based index of the line that looks like the header row */
  headerRow: number
  /** how many lines precede it — the skipRows a profile would need */
  suggestedSkipRows: number
}

/**
 * How many leading lines to search for the header. Real exports open with a
 * preamble: Inter ships five lines (título, conta, período, saldo, blank)
 * before its header, and assuming line 0 is the header makes those files
 * undetectable.
 */
const HEADER_SEARCH_DEPTH = 15

const CANDIDATE_DELIMITERS = [';', ',', '\t', '|']

/** Sniffs the delimiter by which one yields the most columns on the header line. */
export function sniffDelimiter(text: string, skipRows = 0): string {
  const line = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(skipRows)
    .find((l) => l.trim() !== '')

  if (!line) return ';'

  let best = ';'
  let bestCount = 0
  for (const d of CANDIDATE_DELIMITERS) {
    const count = line.split(d).length
    if (count > bestCount) {
      bestCount = count
      best = d
    }
  }
  return best
}

/**
 * Scores every active profile against the file's header row and returns the
 * best match. Detection is a hint for the UI — the user always confirms the
 * profile on the review screen before anything is committed.
 */
export function detectProfile(text: string, profiles: ResolvedProfile[]): Detection {
  const delimiter = sniffDelimiter(text)
  const lines = text.replace(/\r\n/g, '\n').split('\n')

  // Candidate header rows: the first HEADER_SEARCH_DEPTH non-empty lines,
  // each kept with its real index so skipRows can be derived.
  const candidates: Array<{ index: number; cells: string[] }> = []
  for (let i = 0; i < lines.length && candidates.length < HEADER_SEARCH_DEPTH; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const parsed = Papa.parse<string[]>(line, { delimiter, header: false })
    candidates.push({ index: i, cells: (parsed.data[0] ?? []).map((c) => String(c).trim()) })
  }

  const firstCells = candidates[0]?.cells ?? []
  let best: Detection = {
    profileId: null,
    profileName: null,
    score: 0,
    matched: [],
    missing: [],
    headers: firstCells,
    delimiter,
    headerRow: candidates[0]?.index ?? 0,
    suggestedSkipRows: 0,
  }

  for (const candidate of candidates) {
    const present = new Set(candidate.cells.map(headerKey).filter(Boolean))
    if (present.size === 0) continue

    for (const profile of profiles) {
      const signature = profile.headerSignature ?? []
      if (signature.length === 0) continue

      const matched = signature.filter((token) => present.has(headerKey(token)))
      const missing = signature.filter((token) => !present.has(headerKey(token)))
      const score = matched.length / signature.length

      // Ties go to the earlier line, so a preamble that happens to share a
      // token cannot outrank the genuine header.
      if (score > best.score) {
        best = {
          profileId: profile.id,
          profileName: profile.name,
          score,
          matched,
          missing,
          headers: candidate.cells,
          delimiter,
          headerRow: candidate.index,
          suggestedSkipRows: candidate.index,
        }
      }
    }
  }

  // Below two-thirds of the signature we treat it as "unknown bank" and make
  // the user pick, rather than guessing wrong and mangling their amounts.
  if (best.score < 0.67) {
    return {
      ...best,
      profileId: null,
      profileName: null,
      headers: firstCells,
      headerRow: candidates[0]?.index ?? 0,
      suggestedSkipRows: 0,
    }
  }
  return best
}
