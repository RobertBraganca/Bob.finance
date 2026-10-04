import { sql } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { todayIso } from '../core/dates.ts'
import { materializeAll } from './cashFlow.ts'
import { materializeAllDebts } from './debt.ts'

/**
 * Gera as ocorrências futuras de previsões e parcelas de dívida só quando algo
 * que as define mudou, e não a cada leitura.
 *
 * Antes, `GET /cash-flow/pending` e `GET /cash-flow/forecasts` rodavam
 * `materializeAll()` + `materializeAllDebts()` toda vez: três consultas por
 * previsão, em sequência, antes de responder. O Painel abre as duas listas de
 * pendências e as previsões juntas, e cada uma esperava ~3 s (medido em
 * 04/10/2026). O resultado da geração, porém, só muda quando:
 *
 *  - o mês vira (o horizonte é "mês atual + N");
 *  - uma previsão ou dívida é criada, editada, desativada ou apagada;
 *  - um pagamento de dívida entra ou sai (a âncora das parcelas usa a contagem);
 *  - uma ocorrência é pulada (`skipped_occurrences`) ou uma pendência
 *    vinculada é confirmada ou apagada.
 *
 * Tudo isso cabe numa assinatura calculada numa consulta só: o conteúdo
 * inteiro das previsões e dívidas (tabelas de dezenas de linhas), a contagem
 * e o maior id de pagamentos e de ocorrências puladas, a contagem de
 * pendências vinculadas e o mês corrente. Se a assinatura é a da última
 * geração, a leitura segue direto. Na dúvida, a assinatura muda e a geração
 * roda: errar para esse lado custa só tempo.
 *
 * O estado fica no módulo. Numa Edge Function, cada instância nova paga uma
 * geração completa na primeira leitura, como antes; as seguintes, não.
 */
let lastSignature: string | null = null
let inFlight: Promise<void> | null = null

async function signature(): Promise<string> {
  const rows = await db.execute<{ fp: string }>(sql`
    select md5(concat_ws('|',
      (select coalesce(string_agg(row_to_json(f)::text, ',' order by f.id), '') from cash_flow_forecasts f),
      (select coalesce(string_agg(row_to_json(d)::text, ',' order by d.id), '') from debts d),
      (select count(*)::text || ':' || coalesce(max(id), 0)::text from debt_payments),
      (select count(*)::text || ':' || coalesce(max(id), 0)::text from skipped_occurrences),
      (select count(*)::text from transactions t
        where t.pending = true and (t.forecast_id is not null or t.debt_id is not null))
    )) as fp
  `)
  return `${todayIso().slice(0, 7)}:${rows[0]?.fp ?? ''}`
}

async function run(): Promise<void> {
  const before = await signature()
  if (before === lastSignature) return
  await Promise.all([materializeAll(), materializeAllDebts()])
  // Depois de criar linhas, a contagem de pendências vinculadas mudou: a
  // assinatura guardada é a do estado JÁ gerado, senão a próxima leitura
  // rodaria tudo de novo à toa.
  lastSignature = await signature()
}

/** Junta chamadas simultâneas (o Painel pede as três listas ao mesmo tempo). */
export function ensureMaterialized(): Promise<void> {
  inFlight ??= run().finally(() => {
    inFlight = null
  })
  return inFlight
}
