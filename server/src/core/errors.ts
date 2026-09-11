/**
 * Traduz um erro cru do driver Postgres (`postgres` — porsager/postgres,
 * via drizzle-orm/postgres-js) para uma mensagem em pt-BR segura de mostrar
 * ao usuário.
 *
 * O erro que o drizzle lança (`Failed query: <sql> params: <valores>`) é só
 * um wrapper — o erro REAL do Postgres, com o código SQLSTATE e o nome da
 * constraint, vem em `error.cause` (achado de 08/09/2026, ao investigar um
 * "Failed query: update assets..." aparecendo cru numa tela de edição: o
 * handler de erro global (`index.ts`) sempre usava `error.message`, que é
 * literalmente o wrapper, nunca o motivo real).
 */

type PostgresErrorLike = {
  code?: string
  constraint_name?: string
  table_name?: string
  column_name?: string
  detail?: string
}

function postgresErrorOf(error: unknown): PostgresErrorLike | null {
  const cause = error && typeof error === 'object' && 'cause' in error ? (error as { cause?: unknown }).cause : undefined
  for (const candidate of [cause, error]) {
    if (candidate && typeof candidate === 'object' && 'code' in candidate) return candidate as PostgresErrorLike
  }
  return null
}

/** (tabela, constraint) -> mensagem específica, para os casos em que "já existe um registro" não basta. */
const UNIQUE_VIOLATION_MESSAGES: Record<string, string> = {
  'assets/assets_name_uq': 'Já existe um ativo com esse nome. Escolha outro nome, ou edite o ativo existente.',
}

export function friendlyErrorMessage(error: unknown): string {
  const pg = postgresErrorOf(error)
  if (pg?.code === '23505') {
    const key = `${pg.table_name}/${pg.constraint_name}`
    return UNIQUE_VIOLATION_MESSAGES[key] ?? 'Já existe um registro com esse mesmo valor. Escolha um valor diferente.'
  }
  if (pg?.code === '23503') {
    return 'Não é possível concluir: existem outros registros que dependem deste.'
  }
  if (pg?.code === '23502') {
    return 'Um campo obrigatório não foi informado.'
  }
  if (pg?.code === '23514') {
    return 'Um dos valores informados não é permitido para este campo.'
  }
  return error instanceof Error ? error.message : 'erro interno'
}
