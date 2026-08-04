import { FieldError, Input, Label, Select } from '../../components/ui'
import type { Tenant } from '../../types/domain'
import type { WhatsappLineFormState } from './useWhatsappLineForm'

/** `tenants` is only passed (and the "Cliente" select only rendered) when this
 * form isn't already scoped to one tenant -- inside a Cliente's own page the
 * tenant is implicit, so the caller seeds the form with a fixed tenantId and
 * omits `tenants` entirely instead of showing a redundant/editable select. */
export function WhatsappLineFormFields({ form, tenants }: { form: WhatsappLineFormState; tenants?: Tenant[] }) {
  return (
    <div className="space-y-4">
      {tenants && (
        <div>
          <Label htmlFor="line-tenant">Cliente</Label>
          <Select
            id="line-tenant"
            value={form.tenantId}
            invalid={!!form.tenantIdError}
            onChange={(e) => form.setTenantId(e.target.value)}
          >
            <option value="">Selecciona un cliente…</option>
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </Select>
          <FieldError message={form.tenantIdError} />
        </div>
      )}

      <div>
        <Label htmlFor="line-name">Nombre de la línea</Label>
        <Input
          id="line-name"
          value={form.displayName}
          invalid={!!form.displayNameError}
          onChange={(e) => form.setDisplayName(e.target.value)}
          placeholder="Ej. WhatsApp principal"
        />
        <FieldError message={form.displayNameError} />
      </div>

      <div>
        <Label htmlFor="line-phone-number-id">phone_number_id (Meta)</Label>
        <Input
          id="line-phone-number-id"
          value={form.phoneNumberId}
          invalid={!!form.phoneNumberIdError}
          onChange={(e) => form.setPhoneNumberId(e.target.value)}
          placeholder="Ej. 109876543210987"
          inputMode="numeric"
        />
        <FieldError message={form.phoneNumberIdError} />
      </div>

      <div>
        <Label htmlFor="line-business-account-id">business_account_id (Meta)</Label>
        <Input
          id="line-business-account-id"
          value={form.businessAccountId}
          invalid={!!form.businessAccountIdError}
          onChange={(e) => form.setBusinessAccountId(e.target.value)}
          placeholder="Ej. 123456789012345"
          inputMode="numeric"
        />
        <FieldError message={form.businessAccountIdError} />
      </div>
    </div>
  )
}
