import { bps, date as fmtDate, money } from '../../lib/format'
import { Card, EmptyState, KpiTile } from '../../components/ui'
import type { AccountantMonth, AccountantPackage } from './types'

/**
 * O mês da empresa como o contador vê: o mesmo recorte na prévia do dono e no
 * acesso do contador (docs/specs/tarefas-comercial-contador). Só a conta PJ.
 */
export function AccountantMonthView({ month }: { month: AccountantMonth }) {
  if (!month.pjAccount) {
    return (
      <Card>
        <EmptyState icon="info" title="Sem conta da empresa" body="A conta PJ ainda não foi escolhida no Motor financeiro, então não há o que mostrar ao contador." />
      </Card>
    )
  }
  const s = month.summary
  return (
    <div className="stack stack--loose">
      <div className="kpi-row">
        <KpiTile accent label="Faturamento" value={s ? money(s.revenueCents) : '-'} foot={<span>entradas de receita na conta {month.pjAccount.name}</span>} />
        <KpiTile label="DAS" value={s ? money(s.dasCents) : '-'} foot={s?.dasPending ? <span>ainda não pago no mês</span> : <span>pago no mês</span>} />
        <KpiTile label="Custos" value={s ? money(s.costsCents) : '-'} />
        <KpiTile label="Resultado" value={s ? money(s.profitCents) : '-'} foot={s ? <span>retiradas {money(s.withdrawalsCents)}</span> : undefined} />
      </div>
      {month.ceiling && (
        <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          Faturamento no ano: {money(month.ceiling.yearRevenueCents)} de {money(month.ceiling.limitCents)} do teto do MEI ({bps(month.ceiling.usedBps, 0)}).
        </p>
      )}

      <Card title="Notas fiscais emitidas" subtitle="As marcadas como feitas nas tarefas do mês, com o número quando informado">
        {month.invoices.length === 0 ? (
          <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Nenhuma nota marcada como emitida neste mês.</p>
        ) : (
          <ul className="stack stack--tight">
            {month.invoices.map((n, i) => (
              <li key={`${n.dueOn}-${i}`} className="row row--between" style={{ gap: 'var(--sp-2)' }}>
                <span style={{ minWidth: 0, fontSize: 'var(--text-sm)' }}>
                  {n.clientName ?? n.title}
                  <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                    {fmtDate(n.dueOn)}
                  </span>
                </span>
                <strong className="tabular">{n.reference ? `NF ${n.reference}` : 'sem número'}</strong>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        flush
        title="Extrato da conta PJ"
        subtitle={`${month.totals.count} lançamentos · entradas ${money(month.totals.inCents)} · saídas ${money(Math.abs(month.totals.outCents))}`}
      >
        {month.transactions.length === 0 ? (
          <EmptyState icon="list" title="Nenhum lançamento no mês" body="Nada registrado na conta da empresa neste período." />
        ) : (
          <div className="table-wrap">
            <table className="table table--stack-mobile table--stack-compact">
              <thead>
                <tr>
                  <th scope="col">Data</th>
                  <th scope="col">Descrição</th>
                  <th scope="col">TAG</th>
                  <th scope="col">Cliente</th>
                  <th scope="col" className="table__num">Valor</th>
                </tr>
              </thead>
              <tbody>
                {month.transactions.map((t) => (
                  <tr key={t.id}>
                    <td data-label="Data">{fmtDate(t.postedOn)}</td>
                    <td data-label="__lead">
                      <span style={{ overflowWrap: 'anywhere' }}>{t.description}</span>
                      {t.pending && <span className="badge" style={{ marginLeft: 6 }}>pendente</span>}
                    </td>
                    <td data-label="TAG">{t.categoryName ?? <span className="muted">-</span>}</td>
                    <td data-label="Cliente">{t.clientName ?? <span className="muted">-</span>}</td>
                    <td className="table__num" data-label="Valor">
                      <strong className={`tabular ${t.amountCents > 0 ? 'pos' : ''}`}>{money(t.amountCents)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

/** Pacotes já gerados, com os arquivos (links de 1 hora, gerados na hora de abrir). */
export function PackagesList({ packages, onRevoke, revoking }: { packages: AccountantPackage[]; onRevoke?: (p: AccountantPackage) => void; revoking?: boolean }) {
  if (packages.length === 0) return <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Nenhum pacote gerado ainda.</p>
  return (
    <ul className="stack stack--tight">
      {packages.map((p) => (
        <li key={`${p.period}/${p.createdAt}`} className="row row--between row--wrap" style={{ gap: 'var(--sp-2)' }}>
          <span style={{ minWidth: 0, fontSize: 'var(--text-sm)' }}>
            <strong style={{ fontWeight: 600 }}>{p.period.split('-').reverse().join('/')}</strong>
            <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
              gerado em {new Date(Number(p.createdAt)).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
            </span>
          </span>
          <span className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
            {p.files.map((f) =>
              f.url ? (
                <a key={f.name} href={f.url} target="_blank" rel="noreferrer" className="badge badge--info">
                  {f.name.endsWith('.pdf') ? 'PDF' : 'CSV'}
                </a>
              ) : null,
            )}
            {onRevoke && (
              <button type="button" className="link-button" onClick={() => onRevoke(p)} disabled={revoking} style={{ fontSize: 'var(--text-xs)' }}>
                Revogar
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
