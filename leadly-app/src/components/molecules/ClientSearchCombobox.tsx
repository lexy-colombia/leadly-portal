import { getClient, searchClients } from '@/lib/api/clients'
import type { Client } from '@/types/domain'
import { RemoteSearchCombobox } from './RemoteSearchCombobox'

/** Selector de un cliente con búsqueda en el servidor (nombre o teléfono):
 * reemplaza a los ComboboxFilter alimentados con el listado completo del
 * tenant, que se truncaba a 1000. Sin texto muestra los más recientes. */
export function ClientSearchCombobox({
  tenantId,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  optionLabel = (c) => c.full_name,
  className,
  triggerClassName,
  disabled,
}: {
  tenantId: string
  value: string | null
  onChange: (client: Client | null) => void
  placeholder: string
  searchPlaceholder: string
  emptyLabel: string
  optionLabel?: (client: Client) => string
  className?: string
  triggerClassName?: string
  disabled?: boolean
}) {
  return (
    <RemoteSearchCombobox<Client>
      value={value}
      onChange={onChange}
      search={(q) => searchClients(tenantId, q, 20)}
      resolve={getClient}
      getId={(c) => c.id}
      getLabel={optionLabel}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyLabel={emptyLabel}
      className={className}
      triggerClassName={triggerClassName}
      disabled={disabled}
    />
  )
}
