import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseMoney, resolveDate, scoreCandidate } from '../../shared/assistant'

// 12/10/2026 é segunda-feira; 19/10/2026 também.
const TODAY = '2026-10-12'
const date = (text: string, today = TODAY) => resolveDate(text, today).date

describe('resolveDate: datas relativas', () => {
  it('hoje, amanhã e depois de amanhã', () => {
    assert.equal(date('hoje'), '2026-10-12')
    assert.equal(date('Amanhã'), '2026-10-13')
    assert.equal(date('depois de amanhã'), '2026-10-14')
  })

  it('ontem e anteontem (para o Diário)', () => {
    assert.equal(date('paguei ontem'), '2026-10-11')
    assert.equal(date('anteontem'), '2026-10-10')
  })

  it('dia da semana resolve para a próxima ocorrência e hoje conta', () => {
    assert.equal(date('segunda'), '2026-10-12')
    assert.equal(date('segunda-feira'), '2026-10-12')
    assert.equal(date('terça'), '2026-10-13')
    assert.equal(date('quarta'), '2026-10-14')
    assert.equal(date('quinta'), '2026-10-15')
    assert.equal(date('sexta'), '2026-10-16')
    assert.equal(date('sábado'), '2026-10-17')
    assert.equal(date('domingo'), '2026-10-18')
  })

  it('"próxima segunda" numa segunda é a da semana que vem', () => {
    assert.equal(date('próxima segunda'), '2026-10-19')
    assert.equal(date('na próxima sexta'), '2026-10-16')
  })

  it('"segunda parcela" não é dia da semana', () => {
    assert.deepEqual(resolveDate('pagar a segunda parcela', TODAY), { date: null })
  })
})

describe('resolveDate: dia do mês e datas escritas', () => {
  it('"dia 19" é a próxima ocorrência e hoje conta', () => {
    assert.equal(date('dia 19'), '2026-10-19')
    assert.equal(date('dia 12'), '2026-10-12')
  })

  it('"dia 5" que já passou vai para o mês seguinte', () => {
    assert.equal(date('mude para o dia 5'), '2026-11-05')
    assert.equal(date('dia 5', '2026-12-20'), '2027-01-05')
  })

  it('dia que não existe no mês é pulado', () => {
    assert.equal(date('dia 31', '2026-04-20'), '2026-05-31')
    assert.equal(date('dia 30', '2027-01-31'), '2027-03-30')
  })

  it('dd/mm, dd/mm/aaaa e ISO', () => {
    assert.equal(date('19/10'), '2026-10-19')
    assert.equal(date('19/10/2026'), '2026-10-19')
    assert.equal(date('19/10/26'), '2026-10-19')
    assert.equal(date('2026-10-19'), '2026-10-19')
    assert.equal(date('vence 1/11'), '2026-11-01')
  })

  it('dd/mm que já passou neste ano vale o ano seguinte', () => {
    assert.equal(date('5/10'), '2027-10-05')
  })

  it('dia e mês por extenso', () => {
    assert.equal(date('19 de outubro'), '2026-10-19')
    assert.equal(date('dia 5 de novembro'), '2026-11-05')
    assert.equal(date('5 de novembro de 2027'), '2027-11-05')
  })

  it('data inexistente vira pergunta', () => {
    const r = resolveDate('31/02', TODAY)
    assert.equal(r.date, null)
    assert.match(r.question ?? '', /não existe/)
  })

  it('"dia 32" vira pergunta', () => {
    const r = resolveDate('dia 32', TODAY)
    assert.equal(r.date, null)
    assert.match(r.question ?? '', /dia 32/)
  })
})

describe('resolveDate: dia da semana junto do dia do mês', () => {
  it('"segunda dia 19" bate (19/10/2026 é segunda)', () => {
    assert.deepEqual(resolveDate('segunda dia 19', TODAY), { date: '2026-10-19' })
    assert.equal(date('segunda-feira, dia 19'), '2026-10-19')
    assert.equal(date('Segunda feira dia 19'), '2026-10-19')
  })

  it('"terça dia 19" não bate: pergunta dizendo que o 19 cai numa segunda-feira', () => {
    const r = resolveDate('terça dia 19', TODAY)
    assert.equal(r.date, null)
    assert.match(r.question ?? '', /dia 19/)
    assert.match(r.question ?? '', /numa segunda-feira/)
    assert.match(r.question ?? '', /terça-feira/)
    assert.match(r.question ?? '', /Qual vale/)
  })

  it('concordância no masculino: sábado e domingo', () => {
    const r = resolveDate('sábado dia 19', TODAY)
    assert.equal(r.date, null)
    assert.match(r.question ?? '', /numa segunda-feira, não num sábado/)
    assert.equal(date('domingo dia 18'), '2026-10-18')
  })

  it('acha a data mais próxima em que os dois batem, além do mês corrente', () => {
    // 5/11/2026 é quinta-feira
    assert.equal(date('quinta dia 5'), '2026-11-05')
  })

  it('o dia da semana confere com data completa ("terça 19/10" não bate)', () => {
    assert.equal(date('segunda 19/10'), '2026-10-19')
    const r = resolveDate('terça 19/10', TODAY)
    assert.equal(r.date, null)
    assert.match(r.question ?? '', /19\/10\/2026 cai numa segunda-feira/)
  })

  it('dia da semana que não bate com "amanhã" pergunta', () => {
    // amanhã é terça
    assert.equal(date('amanhã terça'), '2026-10-13')
    assert.equal(resolveDate('amanhã quarta', TODAY).date, null)
  })
})

describe('resolveDate: frases completas e ambiguidade', () => {
  it('acha a data no meio de uma frase com valor e nome', () => {
    assert.equal(date('Coral Opus de R$ 750,00 passou para segunda dia 19'), '2026-10-19')
  })

  it('frase sem data devolve null sem pergunta', () => {
    assert.deepEqual(resolveDate('paguei R$ 50 no mercado', TODAY), { date: null })
    assert.deepEqual(resolveDate('', TODAY), { date: null })
  })

  it('duas datas diferentes na mesma frase viram pergunta', () => {
    const r = resolveDate('hoje ou amanhã', TODAY)
    assert.equal(r.date, null)
    assert.match(r.question ?? '', /12\/10\/2026 e 13\/10\/2026/)
  })

  it('a mesma data escrita de dois jeitos não é conflito', () => {
    assert.equal(date('hoje, 12/10'), '2026-10-12')
  })

  it('"today" inválido é erro de quem chama', () => {
    assert.throws(() => resolveDate('hoje', '12/10/2026'), RangeError)
  })

  it('não depende do relógio nem do fuso: mesma entrada, mesma saída', () => {
    assert.equal(date('amanhã', '2026-12-31'), '2027-01-01')
    assert.equal(date('amanhã', '2028-02-28'), '2028-02-29')
  })
})

describe('parseMoney', () => {
  it('com R$', () => {
    assert.equal(parseMoney('R$ 750,00'), 75000)
    assert.equal(parseMoney('R$750'), 75000)
    assert.equal(parseMoney('r$ 12,5'), 1250)
    assert.equal(parseMoney('R$ 0,99'), 99)
  })

  it('sem R$', () => {
    assert.equal(parseMoney('750'), 75000)
    assert.equal(parseMoney('paguei 89,90 no mercado'), 8990)
    assert.equal(parseMoney('750 reais'), 75000)
  })

  it('vírgula decimal e ponto de milhar', () => {
    assert.equal(parseMoney('1.250,50'), 125050)
    assert.equal(parseMoney('1250,5'), 125050)
    assert.equal(parseMoney('R$ 1.250'), 125000)
    assert.equal(parseMoney('1.250.000,00'), 125000000)
  })

  it('ponto decimal com 2 casas no fim', () => {
    assert.equal(parseMoney('750.00'), 75000)
    assert.equal(parseMoney('1,250.50'), 125050)
  })

  it('ponto final de frase não atrapalha', () => {
    assert.equal(parseMoney('Foram R$ 750,00.'), 75000)
  })

  it('porcentagem não vira dinheiro', () => {
    assert.equal(parseMoney('50% finais'), null)
    assert.equal(parseMoney('juros de 1,5 %'), null)
    assert.equal(parseMoney('50% finais de R$ 750,00'), 75000)
  })

  it('data, dia, parcela e hora não viram dinheiro', () => {
    assert.equal(parseMoney('passa para 19/10'), null)
    assert.equal(parseMoney('2026-10-19'), null)
    assert.equal(parseMoney('muda para o dia 19'), null)
    assert.equal(parseMoney('750 dia 19'), 75000)
    assert.equal(parseMoney('3x de 250'), 25000)
    assert.equal(parseMoney('às 14h30 gastei R$ 80'), 8000)
    assert.equal(parseMoney('em 10 dias pago 200'), 20000)
  })

  it('sem valor, vazio ou zero devolve null', () => {
    assert.equal(parseMoney('sem valor nenhum'), null)
    assert.equal(parseMoney(''), null)
    assert.equal(parseMoney('R$ 0'), null)
  })

  it('formato impossível não vira valor inventado', () => {
    assert.equal(parseMoney('12.34.56'), null)
  })
})

describe('scoreCandidate', () => {
  const row = { amountCents: -75000, description: 'CORAL ÓPUS Presentes', postedOn: '2026-10-15' }

  it("'exact': valor, texto e data batem (despesa negativa no banco, positiva na busca)", () => {
    assert.equal(scoreCandidate({ amountCents: 75000, text: 'Coral Opus', date: '2026-10-14' }, row), 'exact')
  })

  it("'exact' só com valor, ou só com valor e texto", () => {
    assert.equal(scoreCandidate({ amountCents: 75000 }, row), 'exact')
    assert.equal(scoreCandidate({ amountCents: 75000, text: 'coral opus' }, row), 'exact')
  })

  it('data no limite de 3 dias ainda é exact; com 4 dias vira likely', () => {
    assert.equal(scoreCandidate({ amountCents: 75000, date: '2026-10-18' }, row), 'exact')
    assert.equal(scoreCandidate({ amountCents: 75000, date: '2026-10-19' }, row), 'likely')
  })

  it('a janela de data atravessa a virada de mês', () => {
    const r = { amountCents: -1000, description: 'Luz', postedOn: '2026-11-01' }
    assert.equal(scoreCandidate({ amountCents: 1000, date: '2026-10-29' }, r), 'exact')
  })

  it("'likely': valor igual e texto diferente", () => {
    assert.equal(scoreCandidate({ amountCents: 75000, text: 'academia' }, row), 'likely')
  })

  it("'likely': texto parecido e valor ausente na busca", () => {
    assert.equal(scoreCandidate({ text: 'coral opus' }, row), 'likely')
    assert.equal(scoreCandidate({ text: 'coral opus', date: '2026-12-01' }, row), 'likely')
  })

  it("'weak': valor diferente, mesmo com texto e data certos", () => {
    assert.equal(scoreCandidate({ amountCents: 80000, text: 'coral opus', date: '2026-10-15' }, row), 'weak')
  })

  it("'weak': texto fraco sem valor, busca vazia e busca só com data", () => {
    assert.equal(scoreCandidate({ text: 'academia' }, row), 'weak')
    assert.equal(scoreCandidate({}, row), 'weak')
    assert.equal(scoreCandidate({ date: '2026-10-15' }, row), 'weak')
  })

  it('texto: 60% das palavras da busca, sem acento, caixa nem palavras de ligação', () => {
    // 2 de 3 palavras (67%) bate; 1 de 2 (50%) não
    assert.equal(scoreCandidate({ text: 'coral opus lancamento' }, row), 'likely')
    assert.equal(scoreCandidate({ text: 'coral lancamento' }, row), 'weak')
    // "pagamento da" sai do cálculo: sobram "coral" e "opus"
    assert.equal(scoreCandidate({ text: 'pagamento da coral opus' }, { ...row, description: 'Coral Opus' }), 'likely')
  })

  it('texto separa palavras por pontuação ("ifood*pedido")', () => {
    const r = { amountCents: -4590, description: 'IFOOD*PEDIDO-123', postedOn: '2026-10-10' }
    assert.equal(scoreCandidate({ amountCents: 4590, text: 'ifood pedido' }, r), 'exact')
  })

  it('data inválida na busca não casa', () => {
    assert.equal(scoreCandidate({ amountCents: 75000, date: 'amanhã' }, row), 'likely')
  })
})
