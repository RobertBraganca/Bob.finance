/**
 * Limite da frase (spec B.6). O contrato (`shared/assistantTypes.ts`) o
 * exporta como `MAX_PHRASE_LENGTH`, mas junto com o zod: importar o valor
 * traria o zod para o pacote da tela. Mantenha igual ao do contrato.
 */
export const MAX_PHRASE_LENGTH = 600
