/**
 * As contas do plano de imóvel e dos contratos amortizados moram em
 * `shared/propertyPlan.ts` (tela e servidor Node). Este arquivo só
 * reexporta, para os serviços importarem `../core/propertyPlan` como o
 * espelho Deno importa `../core/propertyPlan.ts` (a cópia real, porque as
 * Edge Functions não alcançam `shared/`).
 */
export * from '../../../shared/propertyPlan'
