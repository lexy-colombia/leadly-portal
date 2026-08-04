import { FieldError, Input, Label, Select, Textarea } from '../../components/ui'
import { COUNTRIES, DOCUMENT_TYPES, LANGUAGES } from '../../lib/referenceData'
import type { TenantFormState } from './useTenantForm'

export function TenantFormFields({ form }: { form: TenantFormState }) {
  return (
    <div className="space-y-6">
      <div>
        <Label>Tipo</Label>
        <div className="grid grid-cols-2 gap-2">
          {(['empresa', 'persona'] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => form.setEntityType(type)}
              className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                form.entityType === type
                  ? 'border-accent-400 bg-accent-50 text-accent-700'
                  : 'border-brand-200 text-brand-500 hover:bg-brand-50'
              }`}
            >
              {type === 'empresa' ? 'Empresa (persona jurídica)' : 'Persona natural'}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="tenant-name">Nombre comercial</Label>
          <Input
            id="tenant-name"
            value={form.name}
            invalid={!!form.nameError}
            onChange={(e) => form.setName(e.target.value)}
            placeholder="Ej. Panadería Los Andes"
          />
          <FieldError message={form.nameError} />
        </div>

        <div>
          <Label htmlFor="tenant-legal-name">{form.entityType === 'empresa' ? 'Razón social' : 'Nombre completo'}</Label>
          <Input
            id="tenant-legal-name"
            value={form.legalName}
            invalid={!!form.legalNameError}
            onChange={(e) => form.setLegalName(e.target.value)}
            placeholder={form.entityType === 'empresa' ? 'Ej. Panadería Los Andes S.A.S.' : 'Nombre y apellidos'}
          />
          <FieldError message={form.legalNameError} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="tenant-document-type">Tipo de documento</Label>
          <Select
            id="tenant-document-type"
            value={form.documentType}
            invalid={!!form.documentTypeError}
            onChange={(e) => form.setDocumentType(e.target.value as typeof form.documentType)}
          >
            <option value="">Selecciona…</option>
            {DOCUMENT_TYPES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </Select>
          <FieldError message={form.documentTypeError} />
        </div>

        <div>
          <Label htmlFor="tenant-document-number">Número de documento</Label>
          <Input
            id="tenant-document-number"
            value={form.documentNumber}
            invalid={!!form.documentNumberError}
            onChange={(e) => form.setDocumentNumber(e.target.value)}
            placeholder="Ej. 900123456-7"
          />
          <FieldError message={form.documentNumberError} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="tenant-email">Correo de contacto</Label>
          <Input
            id="tenant-email"
            type="email"
            value={form.contactEmail}
            invalid={!!form.emailError}
            onChange={(e) => form.setContactEmail(e.target.value)}
            placeholder="contacto@empresa.com"
          />
          <FieldError message={form.emailError} />
        </div>

        <div>
          <Label htmlFor="tenant-phone">Teléfono de contacto</Label>
          <Input
            id="tenant-phone"
            value={form.contactPhone}
            invalid={!!form.phoneError}
            onChange={(e) => form.setContactPhone(e.target.value)}
            placeholder="+573001234567"
          />
          <FieldError message={form.phoneError} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="tenant-country">País</Label>
          <Select
            id="tenant-country"
            value={form.country}
            invalid={!!form.countryError}
            onChange={(e) => form.setCountry(e.target.value)}
          >
            <option value="">Selecciona…</option>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
          <FieldError message={form.countryError} />
        </div>

        <div>
          <Label htmlFor="tenant-state">Departamento / estado</Label>
          <Input
            id="tenant-state"
            value={form.stateProvince}
            invalid={!!form.stateProvinceError}
            onChange={(e) => form.setStateProvince(e.target.value)}
            placeholder="Ej. Antioquia"
          />
          <FieldError message={form.stateProvinceError} />
        </div>

        <div>
          <Label htmlFor="tenant-language">Idioma preferido</Label>
          <Select id="tenant-language" value={form.preferredLanguage} onChange={(e) => form.setPreferredLanguage(e.target.value as typeof form.preferredLanguage)}>
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div>
        <Label htmlFor="tenant-notes">Notas internas (opcional)</Label>
        <Textarea id="tenant-notes" rows={3} value={form.notes} onChange={(e) => form.setNotes(e.target.value)} />
      </div>
    </div>
  )
}
