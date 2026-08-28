import { KINDS_FOR_DIRECTION, useCategorySelectGroups } from '../../lib/store'
import { DropdownSelect } from './Dropdown'

/**
 * The category picker used everywhere a transaction gets categorized:
 * parent categories render as group headers with their subcategories
 * nested underneath, so the hierarchy is visible at selection time instead
 * of encoded into a "Parent / Child" string.
 *
 * `direction` filters which categories are even offered: a saída only
 * offers despesa/transferência/investimento categories, an entrada only
 * receita/transferência/investimento — never a mismatched receita on an
 * outflow or vice-versa (see `KINDS_FOR_DIRECTION` for why transfer and
 * investment are direction-agnostic while income/expense are not). Omit
 * `direction` when the picker covers rows of mixed or unknown direction
 * (e.g. a bulk selection spanning both) — then every category is offered,
 * same as before this existed.
 */
export function CategorySelect({
  id,
  value,
  onChange,
  direction,
  placeholder = 'Sem categoria',
  bare,
}: {
  id?: string
  value: number | null
  onChange: (value: number | null) => void
  direction?: 'in' | 'out'
  placeholder?: string
  bare?: boolean
}) {
  const groups = useCategorySelectGroups(direction ? KINDS_FOR_DIRECTION[direction] : undefined)

  return (
    <DropdownSelect
      groups={groups.map((g) => ({ label: g.parentName, options: g.options }))}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      ariaLabel="Categoria"
      renderTrigger={({ label, triggerProps }) => (
        <button id={id} {...triggerProps} className={bare ? 'select select--bare' : 'select'}>
          <span className="select__value truncate">{label}</span>
        </button>
      )}
    />
  )
}
