import { Icon, type IconName } from './Icon'
import { DropdownSelect } from './Dropdown'

/**
 * The canonical filter/scope control — a pill trigger with a leading icon,
 * the current value as its own label (no separate `<label>` above it), and
 * a trailing chevron. This is the one shape every dropdown that SCOPES a
 * view (date range, account, asset class, direction…) should use, so a
 * user learns the pattern once. It is distinct from `Select`, which stays
 * a plain rectangular control for form fields inside modals/forms — a
 * field being filled in is not a filter, and forcing it into a pill with
 * no visible label would make the form harder to read, not easier.
 */
export function FilterSelect<T extends string | number>({
  icon,
  value,
  options,
  onChange,
  placeholder,
}: {
  icon: IconName
  value: T | null
  options: Array<{ value: T; label: string }>
  onChange: (value: T | null) => void
  placeholder?: string
}) {
  return (
    <DropdownSelect
      groups={[{ options }]}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      ariaLabel={placeholder}
      panelMinWidth={220}
      renderTrigger={({ label, triggerProps }) => (
        <button {...triggerProps} className="filter-select">
          <Icon name={icon} size={14} className="filter-select__icon" />
          <span className="filter-select__value">{label}</span>
          <Icon name="chevronDown" size={13} className="filter-select__chevron" />
        </button>
      )}
    />
  )
}
