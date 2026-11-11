import { useCallback, useState } from 'react'

/**
 * "Sem categoria → regra automática" (decisions/0047, 11/11/2026): dar TAG a
 * um lançamento cria, por padrão, uma regra para o mesmo estabelecimento
 * (`saveAsRule` em POST /transactions/categorize). O usuário pode desmarcar;
 * a escolha vale para Lançamentos e para o Painel e fica neste navegador.
 */
const KEY = 'categorize.saveAsRule'

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export function useSaveAsRulePref(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(read)
  const set = useCallback((next: boolean) => {
    setValue(next)
    try {
      localStorage.setItem(KEY, next ? '1' : '0')
    } catch {
      // localStorage indisponível: a escolha dura só esta tela.
    }
  }, [])
  return [value, set]
}

export type CategorizeResult = {
  updated: number
  learned: Array<{ signature: string; hits: number; promoted: boolean }>
  ruleId: number | null
  rulesCreated?: number
  alsoCategorized?: number
}

/** Uma frase para o toast depois de dar TAG. */
export function categorizeMessage(result: CategorizeResult): string {
  const parts = [result.updated === 1 ? 'TAG aplicada' : `${result.updated} lançamentos atualizados`]
  const created = result.rulesCreated ?? (result.ruleId ? 1 : 0)
  if (created > 0) parts.push(created === 1 ? 'regra criada para o estabelecimento' : `${created} regras criadas`)
  else if (result.ruleId) parts.push('regra do estabelecimento atualizada')
  const also = result.alsoCategorized ?? 0
  if (also > 0) parts.push(`mais ${also} sem TAG do mesmo estabelecimento ${also === 1 ? 'categorizado' : 'categorizados'}`)
  const promoted = result.learned.filter((l) => l.promoted).length
  if (promoted > 0) parts.push(`${promoted} padrão(ões) promovido(s) a regra`)
  return parts.join(' · ')
}
