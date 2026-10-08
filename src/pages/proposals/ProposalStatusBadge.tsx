import { STATUS_BADGE, STATUS_LABEL, type ProposalStatus } from './types'

/** Status nunca só pela cor: o selo sempre leva o nome. */
export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  return (
    <span className={STATUS_BADGE[status]}>
      <span className="dot" aria-hidden="true" style={{ background: 'currentColor', width: 6, height: 6 }} />
      {STATUS_LABEL[status]}
    </span>
  )
}
