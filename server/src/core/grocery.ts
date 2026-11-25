/**
 * As contas da lista de compras moram em `shared/grocery.ts` (tela e servidor
 * Node). Este arquivo só reexporta, para os serviços importarem
 * `../core/grocery` como o espelho Deno importa `../core/grocery.ts` (a cópia
 * real, porque as Edge Functions não alcançam `shared/`).
 */
export * from '../../../shared/grocery'
