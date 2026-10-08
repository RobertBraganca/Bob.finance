/**
 * As contas do orçamento moram em `shared/proposals.ts` (tela e servidor
 * Node). Este arquivo só reexporta, para `services/proposals.ts` importar
 * `../core/proposals` como o espelho Deno importa
 * `../core/proposals.ts` (que é a cópia real, porque as Edge Functions não
 * alcançam `shared/`).
 */
export * from '../../../shared/proposals'
