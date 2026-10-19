import type { MatchStrength } from './assistantTypes.ts'

/**
 * Funções puras do assistente (sem banco e sem rede), compartilhadas entre o
 * servidor Node e as Edge Functions. Cobertas por scripts/assistant/core.test.ts.
 *
 * Nada aqui importa de `server/` (shared não pode) nem lê o relógio: quem chama
 * passa `today`. Toda conta de data é feita em UTC sobre números de dia, então o
 * fuso da máquina não muda o resultado.
 */

/* ------------------------------------------------------------------ *
 * Texto
 * ------------------------------------------------------------------ */

// Faixa de marcas combinantes U+0300..U+036F montada por código de caractere, como
// em server/src/core/normalize.ts, para o arquivo não depender de codificação.
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g')

/** Minúsculas e sem acento; mantém a pontuação (a leitura de data e valor precisa dela). */
function fold(input: string): string {
  return String(input ?? '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
}

/**
 * Mesma regra de `normalizeDescription` (server/src/core/normalize.ts: minúsculas,
 * sem acento, sem ruído, espaços colapsados), com uma diferença de propósito: aqui
 * `/ . -` também viram espaço, para "ifood*pedido-123" separar em palavras e a
 * comparação ser por palavra.
 */
function normalizeText(input: string): string {
  return fold(input)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ------------------------------------------------------------------ *
 * Datas (aritmética pura em UTC, dia = dias desde 1970-01-01)
 * ------------------------------------------------------------------ */

const DAY_MS = 86_400_000

function utcDays(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS)
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Dia (número) de uma data real; null se o mês ou o dia não existem. */
function validDays(y: number, m: number, d: number): number | null {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null
  return utcDays(y, m, d)
}

function parseIso(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? validDays(Number(m[1]), Number(m[2]), Number(m[3])) : null
}

function isoOf(days: number): string {
  return new Date(days * DAY_MS).toISOString().slice(0, 10)
}

/** dd/mm/aaaa, o formato que o usuário lê. */
function brOf(days: number): string {
  const [y, m, d] = isoOf(days).split('-')
  return `${d}/${m}/${y}`
}

/** 0 = domingo ... 6 = sábado. */
function weekdayOf(days: number): number {
  return new Date(days * DAY_MS).getUTCDay()
}

const WEEKDAYS: Array<{ nome: string; feminino: boolean }> = [
  { nome: 'domingo', feminino: false },
  { nome: 'segunda-feira', feminino: true },
  { nome: 'terça-feira', feminino: true },
  { nome: 'quarta-feira', feminino: true },
  { nome: 'quinta-feira', feminino: true },
  { nome: 'sexta-feira', feminino: true },
  { nome: 'sábado', feminino: false },
]
const WEEKDAY_KEYS = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']

/** "numa segunda-feira" / "num sábado" */
const emUm = (wd: number) => `${WEEKDAYS[wd]!.feminino ? 'numa' : 'num'} ${WEEKDAYS[wd]!.nome}`
/** "a segunda-feira" / "o sábado" */
const umA = (wd: number) => `${WEEKDAYS[wd]!.feminino ? 'a' : 'o'} ${WEEKDAYS[wd]!.nome}`

const MONTHS: Record<string, number> = {
  janeiro: 1, jan: 1, fevereiro: 2, fev: 2, marco: 3, mar: 3, abril: 4, abr: 4, maio: 5, mai: 5,
  junho: 6, jun: 6, julho: 7, jul: 7, agosto: 8, ago: 8, setembro: 9, set: 9, outubro: 10, out: 10,
  novembro: 11, nov: 11, dezembro: 12, dez: 12,
}

/** Primeira data (hoje conta) com esse dia do mês; meses curtos são pulados. */
function nextDayOfMonth(today: number, dom: number): number | null {
  const base = new Date(today * DAY_MS)
  let y = base.getUTCFullYear()
  let m = base.getUTCMonth() + 1
  for (let i = 0; i < 24; i += 1) {
    const days = validDays(y, m, dom)
    if (days !== null && days >= today) return days
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return null
}

/** Primeira data (hoje conta) em "dia/mês" sem ano; 29/02 espera o próximo bissexto. */
function nextDayMonth(today: number, d: number, m: number): number | null {
  const y0 = new Date(today * DAY_MS).getUTCFullYear()
  for (let y = y0; y <= y0 + 8; y += 1) {
    const days = validDays(y, m, d)
    if (days !== null && days >= today) return days
  }
  return null
}

function nextWeekday(today: number, wd: number, strictlyAfter: boolean): number {
  let delta = (wd - weekdayOf(today) + 7) % 7
  if (delta === 0 && strictlyAfter) delta = 7
  return today + delta
}

export type ResolvedDate = {
  /** AAAA-MM-DD, ou null quando não deu para resolver com segurança */
  date: string | null
  /** pergunta em português quando a frase é ambígua ou o dia da semana não bate */
  question?: string
}

// "segunda parcela", "segunda via" etc. são ordinais, não dia da semana.
const ORDINAL_NEXT = '(?:parcela|via|vez|chance|opcao|etapa|metade|quinzena|parte|fase|rodada)'

/**
 * "segunda dia 19", "dia 19", "amanhã", "sexta", "19/10", "2026-10-19".
 * `today` é a data de hoje em America/Sao_Paulo. Se a frase cita dia da semana E
 * dia do mês e os dois não coincidem em nenhuma data próxima, devolve pergunta.
 *
 * Regras de interpretação:
 *  - Formas aceitas: "hoje", "ontem", "anteontem", "amanhã", "depois de amanhã",
 *    dia da semana ("segunda", "segunda-feira"), "dia 19", "19/10", "19/10/2026",
 *    "2026-10-19", "19 de outubro [de 2026]".
 *  - Dia da semana sozinho: próxima ocorrência, e hoje conta; "próxima segunda"
 *    nunca é hoje.
 *  - "dia 19" e "19/10" sem ano: próxima ocorrência futura, hoje conta. Se já
 *    passou neste mês (ou neste ano), vale o mês seguinte (o ano seguinte);
 *    mês sem esse dia é pulado ("dia 31" em novembro vai para dezembro).
 *  - Dia da semana + dia do mês: a data mais próxima (até 40 dias à frente) em
 *    que os dois batem. Se nenhuma bate, pergunta, nunca corrige sozinho.
 *  - Dia da semana junto de uma data explícita ("terça 19/10"): confere os dois.
 *  - Duas datas diferentes na mesma frase, ou data inexistente (31/02): pergunta.
 *  - Sem data na frase: `{ date: null }`, sem pergunta.
 */
export function resolveDate(text: string, today: string): ResolvedDate {
  const todayDays = parseIso(today)
  if (todayDays === null) throw new RangeError(`resolveDate: "today" inválido (${today})`)
  const t = fold(text)

  const ask = (question: string): ResolvedDate => ({ date: null, question })

  /* Datas explícitas e relativas ("âncoras") */
  const anchors: number[] = []
  const invalid: string[] = []
  const addAnchor = (days: number | null, label: string) => {
    if (days === null) invalid.push(label)
    else if (!anchors.includes(days)) anchors.push(days)
  }

  for (const m of t.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) {
    addAnchor(validDays(Number(m[1]), Number(m[2]), Number(m[3])), m[0])
  }
  for (const m of t.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g)) {
    const d = Number(m[1])
    const mo = Number(m[2])
    if (m[3] !== undefined) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
      addAnchor(validDays(y, mo, d), m[0])
    } else {
      // dia e mês que nem existem no calendário (13/13) não viram data nenhuma
      const exists = mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(2024, mo)
      if (!exists) invalid.push(m[0])
      else addAnchor(nextDayMonth(todayDays, d, mo), m[0])
    }
  }
  const monthNames = Object.keys(MONTHS).join('|')
  const monthRe = new RegExp(`(?<!\\d)(\\d{1,2})\\s+de\\s+(${monthNames})\\b(?:\\s+de\\s+(\\d{4}))?`, 'g')
  for (const m of t.matchAll(monthRe)) {
    const d = Number(m[1])
    const mo = MONTHS[m[2]!]!
    if (m[3] !== undefined) addAnchor(validDays(Number(m[3]), mo, d), m[0])
    else if (d < 1 || d > daysInMonth(2024, mo)) invalid.push(m[0])
    else addAnchor(nextDayMonth(todayDays, d, mo), m[0])
  }

  if (/\bdepois de amanha\b/.test(t)) addAnchor(todayDays + 2, 'depois de amanhã')
  else if (/\bamanha\b/.test(t)) addAnchor(todayDays + 1, 'amanhã')
  if (/\banteontem\b/.test(t)) addAnchor(todayDays - 2, 'anteontem')
  else if (/\bontem\b/.test(t)) addAnchor(todayDays - 1, 'ontem')
  if (/\bhoje\b/.test(t)) addAnchor(todayDays, 'hoje')

  if (invalid.length > 0) {
    return ask(`A data "${invalid[0]}" não existe no calendário. Qual é a data certa?`)
  }

  /* Dia da semana e dia do mês */
  const weekdays: Array<{ wd: number; strict: boolean }> = []
  const wdRe = new RegExp(`\\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:[- ]feira)?\\b(?!\\s+${ORDINAL_NEXT})`, 'g')
  for (const m of t.matchAll(wdRe)) {
    const wd = WEEKDAY_KEYS.indexOf(m[1]!)
    const strict = /\bproxim[ao]\s+$/.test(t.slice(0, m.index))
    if (!weekdays.some((w) => w.wd === wd)) weekdays.push({ wd, strict })
  }
  if (weekdays.length > 1) {
    return ask('A frase cita mais de um dia da semana. Qual deles vale?')
  }

  const doms: number[] = []
  // "dia 19" mas não "dia 19/10" (data completa) nem "dia 19 de outubro" (já lida acima)
  for (const m of t.matchAll(/\bdia\s+(\d{1,2})(?!\d)(?!\s*\/\s*\d)(?!\s+de\s+[a-z])/g)) {
    const d = Number(m[1])
    if (!doms.includes(d)) doms.push(d)
  }
  if (doms.length > 1) {
    return ask(`A frase cita mais de um dia do mês (${doms.join(' e ')}). Qual deles vale?`)
  }
  const dom = doms[0]
  if (dom !== undefined && (dom < 1 || dom > 31)) {
    return ask(`O dia ${dom} não existe. Qual é o dia certo?`)
  }
  const weekday = weekdays[0]

  const found: number[] = [...anchors]

  if (weekday && anchors.length > 0) {
    // dia da semana ao lado de uma data explícita ou relativa: só confere
    const wrong = anchors.find((a) => weekdayOf(a) !== weekday.wd)
    if (wrong !== undefined) {
      return ask(`${brOf(wrong)} cai ${emUm(weekdayOf(wrong))}, não ${emUm(weekday.wd)}. Qual data vale?`)
    }
  }

  if (dom !== undefined) {
    if (weekday && anchors.length === 0) {
      let match: number | null = null
      for (let i = 0; i <= 40; i += 1) {
        const day = todayDays + i
        if (weekdayOf(day) !== weekday.wd) continue
        if (Number(isoOf(day).slice(8)) === dom && !(weekday.strict && i === 0)) {
          match = day
          break
        }
      }
      if (match === null) {
        const real = nextDayOfMonth(todayDays, dom)
        if (real === null) return ask(`O dia ${dom} não existe nos próximos meses. Qual é a data certa?`)
        return ask(
          `O dia ${dom} (${brOf(real)}) cai ${emUm(weekdayOf(real))}, não ${emUm(weekday.wd)}. Qual vale: o dia ${dom} ou ${umA(weekday.wd)}?`,
        )
      }
      found.push(match)
    } else {
      const next = nextDayOfMonth(todayDays, dom)
      if (next === null) return ask(`O dia ${dom} não existe nos próximos meses. Qual é a data certa?`)
      if (!found.includes(next)) found.push(next)
    }
  } else if (weekday && anchors.length === 0) {
    found.push(nextWeekday(todayDays, weekday.wd, weekday.strict))
  }

  if (found.length === 0) return { date: null }
  if (found.length > 1) {
    const ordered = [...found].sort((a, b) => a - b)
    return ask(`A frase cita datas diferentes (${ordered.map(brOf).join(' e ')}). Qual delas vale?`)
  }
  return { date: isoOf(found[0]!) }
}

/* ------------------------------------------------------------------ *
 * Dinheiro
 * ------------------------------------------------------------------ */

/**
 * Converte um número escrito ("1.250,50", "750.00", "1250,5", "1.250") em
 * centavos. A regra do último separador: com vírgula E ponto, o que vem por
 * último é o decimal; sozinho, o separador é decimal se tiver 1 ou 2 casas
 * depois, e de milhar se tiver exatamente 3 ("R$ 1.250" = mil duzentos e
 * cinquenta). Formato que não se encaixa ("12.34.56") devolve null.
 */
function numberToCents(token: string): number | null {
  let int: string
  let frac = ''
  const lastDot = token.lastIndexOf('.')
  const lastComma = token.lastIndexOf(',')

  const thousands = (s: string, sep: string): string | null => {
    const parts = s.split(sep)
    const [first, ...rest] = parts
    if (!first || first.length > 3 || first.startsWith('0') || !rest.every((p) => p.length === 3)) return null
    return parts.join('')
  }

  if (lastDot >= 0 && lastComma >= 0) {
    const at = Math.max(lastDot, lastComma)
    const head = token.slice(0, at)
    frac = token.slice(at + 1)
    const sep = at === lastComma ? '.' : ','
    if (head.includes(at === lastComma ? ',' : '.')) return null
    const joined = head.includes(sep) ? thousands(head, sep) : head
    if (joined === null) return null
    int = joined
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ','
    const parts = token.split(sep)
    const last = parts[parts.length - 1]!
    if (parts.length === 2 && last.length >= 1 && last.length <= 2 && parts[0] !== '') {
      int = parts[0]!
      frac = last
    } else {
      const joined = thousands(token, sep)
      if (joined === null) return null
      int = joined
    }
  } else {
    int = token
  }

  if (!/^\d+$/.test(int) || (frac !== '' && !/^\d{1,2}$/.test(frac)) || int.length > 12) return null
  return Number(int) * 100 + Number(frac.padEnd(2, '0') || '0')
}

// Palavras que, logo depois de um número, dizem que ele não é dinheiro.
const NOT_MONEY_AFTER = /^\s*(?:dias|dia(?!\s*\d)|x(?![a-z])|vezes|parcelas?|meses|mes(?![a-z])|anos?|cotas?|acoes|unidades?|h(?:s|oras?)?(?![a-z]))/

/**
 * "R$ 750,00", "750", "1.250,50", "750.00", "R$750": centavos, ou null.
 *
 * Com "R$" (ou "reais" depois) o número é dinheiro; sem, vale o primeiro número
 * "solto" que não seja parte de data ("19/10", "2026-10-19", "dia 19"), porcentagem
 * ("50%"), duração ou quantidade ("3x", "10 dias", "100 cotas") nem grudado em letra
 * ("h30"). Quando há os dois, o que tem "R$" ganha. Zero não é valor (as ações
 * exigem valor positivo), então "R$ 0" devolve null.
 */
export function parseMoney(text: string): number | null {
  const t = fold(text)
  let bare: number | null = null

  for (const m of t.matchAll(/\d[\d.,]*/g)) {
    const token = m[0].replace(/[.,]+$/, '')
    const start = m.index!
    const before = t.slice(0, start)
    const after = t.slice(start + token.length)

    if (/^\s*(?:%|por\s*cento)/.test(after)) continue
    if (/\d\/$/.test(before) || /^\/\d/.test(after) || /\d-$/.test(before) || /^-\d/.test(after)) continue

    const cents = numberToCents(token)
    if (cents === null || cents <= 0) continue

    const symbol = /r\$\s*$/.test(before) || /^\s*(?:reais|real|contos?)(?![a-z])/.test(after)
    if (symbol) return cents
    if (bare !== null) continue
    if (/[a-z]$/.test(before) || /\bdias?\s*$/.test(before) || NOT_MONEY_AFTER.test(after)) continue
    bare = cents
  }
  return bare
}

/* ------------------------------------------------------------------ *
 * Casamento
 * ------------------------------------------------------------------ */

// Palavras de ligação que não identificam o lançamento ("pagamento da Coral Opus").
const STOP_TOKENS = new Set(['a', 'o', 'as', 'os', 'e', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas', 'um', 'uma', 'para', 'pra', 'por', 'com'])

function tokensOf(text: string): string[] {
  const all = normalizeText(text).split(' ').filter(Boolean)
  const content = all.filter((tok) => !STOP_TOKENS.has(tok))
  return [...new Set(content.length > 0 ? content : all)]
}

/**
 * Força do casamento entre o que a frase diz e uma linha do banco: valor igual
 * (peso maior), texto normalizado (`normalizeDescription`) e distância de data.
 * Campos ausentes na busca não pesam.
 *
 * Critérios (só valem os que a busca trouxe):
 *  - valor: igual em módulo (o banco guarda despesa com sinal negativo; a frase não);
 *  - texto: pelo menos 60% das palavras da busca (normalizadas, sem palavras de
 *    ligação) aparecem na descrição da linha;
 *  - data: até 3 dias de diferença do lançamento.
 *
 * Resultado:
 *  - 'exact': a busca traz valor e TODOS os critérios que ela traz batem;
 *  - 'likely': valor igual mas outro critério falhou, OU a busca não traz valor e
 *    o texto bate (a data, se houver, não decide);
 *  - 'weak': o resto, inclusive busca vazia, só com data e valor diferente.
 */
export function scoreCandidate(
  query: { amountCents?: number; text?: string; date?: string },
  row: { amountCents: number; description: string; postedOn: string },
): MatchStrength {
  const hasAmount = query.amountCents !== undefined
  const queryTokens = query.text !== undefined ? tokensOf(query.text) : []
  const hasText = queryTokens.length > 0
  const hasDate = query.date !== undefined

  const amountOk = hasAmount && Math.abs(query.amountCents!) === Math.abs(row.amountCents)

  let textOk = false
  if (hasText) {
    const rowTokens = new Set(normalizeText(row.description).split(' '))
    const common = queryTokens.filter((tok) => rowTokens.has(tok)).length
    textOk = common / queryTokens.length >= 0.6
  }

  let dateOk = false
  if (hasDate) {
    const q = parseIso(query.date!)
    const r = parseIso(row.postedOn)
    dateOk = q !== null && r !== null && Math.abs(q - r) <= 3
  }

  if (hasAmount && amountOk && (!hasText || textOk) && (!hasDate || dateOk)) return 'exact'
  if (hasAmount && amountOk) return 'likely'
  if (!hasAmount && hasText && textOk) return 'likely'
  return 'weak'
}
