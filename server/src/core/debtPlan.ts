/**
 * As contas do Endividamento v2 moram em `shared/debt.ts` (tela e servidor
 * Node). Este arquivo só reexporta, como `core/propertyPlan`; o espelho Deno
 * tem a cópia real.
 */
export * from '../../../shared/debt'
