import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as simulator from '../services/simulator'

/**
 * Simulador de decisões. Ver `specs/decision-simulator` e `decisions/0016`.
 *
 * POST em ambas as rotas porque o corpo não cabe numa query string, nunca
 * porque escrevem: nenhuma das duas grava em tabela alguma.
 */
const sourceSchema = z.enum(['balance', 'reserve', 'investment'])
const periodSchema = z.string().regex(/^\d{4}-\d{2}$/).optional()

export async function simulateRoutes(app: FastifyInstance) {
  app.post('/simulate/one-time-expense', async (req) => {
    const body = z
      .object({
        amountCents: z.number().int().positive(),
        source: sourceSchema,
        accountId: z.number().int().positive().nullable().optional(),
        period: periodSchema,
      })
      .parse(req.body)
    // Valor maior que a origem disponível NÃO é erro: o usuário pode estar
    // simulando exatamente para descobrir que não cabe (ver spec).
    return simulator.simulateOneTimeExpense(body)
  })

  app.post('/simulate/debt-payoff', async (req, reply) => {
    const body = z
      .object({
        debtId: z.number().int().positive(),
        source: sourceSchema,
        period: periodSchema,
      })
      .parse(req.body)
    try {
      return await simulator.simulateDebtPayoff(body)
    } catch (error) {
      // Dívida inexistente ou já quitada é estado do dado, não falha de
      // servidor: mesma resposta que o resto do app dá para "não calcula".
      if (error instanceof simulator.SimulatorError) return reply.code(422).send({ error: error.message })
      throw error
    }
  })

  app.post('/simulate/decumulation', async (req) => {
    const body = z
      .object({
        monthlyWithdrawalCents: z.number().int().positive(),
        expectedReturnBps: z.number().int().min(-10_000).max(100_000),
        horizonMonths: z.number().int().positive().max(1200).optional(),
      })
      .parse(req.body)
    return simulator.simulateDecumulation(body)
  })
}
