import { useEffect, useRef, useState } from 'react'
import {
  getIntegrationCredential,
  getIntegrationCredentialConfiguredSecrets,
  setIntegrationCredentialConfig,
  setIntegrationCredentialMode,
  setIntegrationCredentialSecret,
} from '../../../lib/api/integrations'
import {
  createTenantWithholdingConfig,
  deleteTenantWithholdingConfig,
  getTenantDianProfile,
  listTaxTypes,
  listTenantWithholdingConfigs,
  syncDianNumberingRange,
  updateTenantDianProfile,
  type DianNumberingRange,
} from '../../../lib/api/tenantDianProfile'
import { uploadCertificateFile, validateCertificateFile } from '../../../lib/api/dianCertificate'
import type { TaxType, TenantWithholdingConfig } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { GeoSelect } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { IntegrationStatusBanner } from './IntegrationStatusBanner'
import { IntegrationFieldLabel, IntegrationSection } from './IntegrationFieldLabel'
import { TrashIcon, UploadIcon } from '@/components/atoms/icons'
import { RefreshCwIcon } from 'lucide-react'
import { useLanguage } from '../../../contexts/LanguageContext'
import { useToast } from '../../../contexts/ToastContext'

const PROVIDER_KEY = 'dian_directo'
const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const DIAN_HABILITACION_URL = 'https://vpfe-hab.dian.gov.co/WcfDianCustomerServices.svc'
const DIAN_PRODUCTION_URL = 'https://vpfe.dian.gov.co/WcfDianCustomerServices.svc'

/** Cada tenant es su propio facturador electrónico DIAN -- este drawer es
 * donde carga su certificado digital (.p12/.pfx), su resolución de
 * facturación, y configura sus propias tarifas de retención. Leadly nunca
 * es Proveedor Tecnológico -- ver CLAUDE.md. Mismo patrón de credenciales
 * que LaFacturaCredentialDrawer/WompiIntegrationDrawer (integration_credentials
 * + integration_credential_secrets), más: (1) un campo de archivo para el
 * certificado (bucket privado tenant-certificates, no cabe en config jsonb
 * ni en un secreto de texto), y (2) el perfil DIAN del tenant
 * (tenant_dian_profile) + sus tarifas de retención (tenant_withholding_configs),
 * que no son parte del sistema genérico de integraciones -- son propias de
 * este módulo. */
export function DianDirectoCredentialDrawer({
  open,
  onClose,
  tenantId,
  description,
}: {
  open: boolean
  onClose: () => void
  tenantId: string | null
  description: string
}) {
  const { t } = useLanguage()
  const toast = useToast()
  const [mode, setMode] = useState<'sandbox' | 'production'>('sandbox')
  const [certificateFilename, setCertificateFilename] = useState('')
  const [certificatePassword, setCertificatePassword] = useState('')
  const [technicalKey, setTechnicalKey] = useState('')
  const [softwarePin, setSoftwarePin] = useState('')
  const [configuredSecrets, setConfiguredSecrets] = useState<string[]>([])

  const [taxEnabled, setTaxEnabled] = useState(false)
  const [fiscalRegime, setFiscalRegime] = useState<'responsable_iva' | 'no_responsable_iva' | ''>('')
  const [isSelfWithholdingAgent, setIsSelfWithholdingAgent] = useState(false)
  const [city, setCity] = useState('')
  const [cityCode, setCityCode] = useState('')
  const [stateCode, setStateCode] = useState('')
  const [resolutionNumber, setResolutionNumber] = useState('')
  const [resolutionPrefix, setResolutionPrefix] = useState('')
  const [resolutionRangeFrom, setResolutionRangeFrom] = useState('')
  const [resolutionRangeTo, setResolutionRangeTo] = useState('')
  const [resolutionValidFrom, setResolutionValidFrom] = useState('')
  const [resolutionValidUntil, setResolutionValidUntil] = useState('')
  const [softwareId, setSoftwareId] = useState('')
  const [testSetId, setTestSetId] = useState('')
  const [webserviceUrl, setWebserviceUrl] = useState('')
  const [creditNotePrefix, setCreditNotePrefix] = useState('')

  // Botón "Sincronizar con la DIAN" -- pedido explícito del usuario
  // 2026-09-09: en vez de copiar a mano prefijo/rango/vigencia cada vez
  // que cambia la resolución, traerlos directo de la DIAN
  // (GetNumberingRangeAsync). Deliberadamente manual, no automático (ver
  // handleSyncResolution) -- decisión explícita del usuario por ahora.
  const [syncingResolution, setSyncingResolution] = useState(false)
  const [resolutionSyncError, setResolutionSyncError] = useState<string | null>(null)
  const [resolutionSyncNote, setResolutionSyncNote] = useState<string | null>(null)

  const [taxTypes, setTaxTypes] = useState<TaxType[]>([])
  const [withholdingConfigs, setWithholdingConfigs] = useState<TenantWithholdingConfig[]>([])
  const [newWithholdingType, setNewWithholdingType] = useState('')
  const [newWithholdingConcept, setNewWithholdingConcept] = useState('')
  const [newWithholdingRate, setNewWithholdingRate] = useState('')

  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [uploadingCert, setUploadingCert] = useState(false)
  const [certError, setCertError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open || !tenantId) return
    setLoaded(false)
    setError(null)
    setCertificatePassword('')
    setTechnicalKey('')
    setSoftwarePin('')

    Promise.all([
      getIntegrationCredential(PROVIDER_KEY, tenantId),
      getTenantDianProfile(tenantId),
      listTaxTypes(),
      listTenantWithholdingConfigs(tenantId),
    ])
      .then(async ([credential, profile, types, configs]) => {
        setMode(credential?.mode ?? 'sandbox')
        const config = (credential?.config ?? {}) as Record<string, unknown>
        setCertificateFilename(typeof config.certificate_filename === 'string' ? config.certificate_filename : '')
        setConfiguredSecrets(credential ? await getIntegrationCredentialConfiguredSecrets(credential.id) : [])

        setTaxEnabled(profile?.tax_enabled ?? false)
        setFiscalRegime(profile?.fiscal_regime ?? '')
        setIsSelfWithholdingAgent(profile?.is_self_withholding_agent ?? false)
        setCity(profile?.city ?? '')
        setCityCode(profile?.city_code ?? '')
        setStateCode(profile?.state_code ?? '')
        setResolutionNumber(profile?.resolution_number ?? '')
        setResolutionPrefix(profile?.resolution_prefix ?? '')
        setResolutionRangeFrom(profile?.resolution_range_from != null ? String(profile.resolution_range_from) : '')
        setResolutionRangeTo(profile?.resolution_range_to != null ? String(profile.resolution_range_to) : '')
        setResolutionValidFrom(profile?.resolution_valid_from ?? '')
        setResolutionValidUntil(profile?.resolution_valid_until ?? '')
        setSoftwareId(profile?.software_id ?? '')
        setTestSetId(profile?.test_set_id ?? '')
        setWebserviceUrl(profile?.webservice_url ?? '')
        setCreditNotePrefix(profile?.credit_note_prefix ?? '')

        setTaxTypes(types.filter((tx) => tx.category === 'retencion'))
        setWithholdingConfigs(configs)
        setLoaded(true)
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('integrations.errors.load')))
  }, [open, tenantId])

  async function handleModeChange(next: 'sandbox' | 'production') {
    setError(null)
    try {
      await setIntegrationCredentialMode(PROVIDER_KEY, tenantId, next)
      setMode(next)
      // La URL del web service va de la mano del ambiente (habilitación y
      // producción son endpoints distintos de la DIAN). Si todavía apunta al
      // otro ambiente se corrige sola -- queda editable igual, por si la
      // DIAN cambia el endpoint. No se guarda acá: el usuario la ve en el
      // campo y la confirma con "Guardar cambios", como el resto del perfil.
      const pointsToOther = next === 'production' ? webserviceUrl.includes('vpfe-hab.') : webserviceUrl.includes('//vpfe.')
      if (!webserviceUrl.trim() || pointsToOther) {
        setWebserviceUrl(next === 'production' ? DIAN_PRODUCTION_URL : DIAN_HABILITACION_URL)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('integrations.errors.save'))
    }
  }

  async function handleCertificateSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!file || !tenantId) return
    const validationError = validateCertificateFile(file)
    if (validationError) {
      setCertError(t(validationError))
      return
    }
    setCertError(null)
    setUploadingCert(true)
    try {
      const uploaded = await uploadCertificateFile(tenantId, file)
      await setIntegrationCredentialConfig(PROVIDER_KEY, tenantId, {
        storage_path: uploaded.storage_path,
        certificate_filename: uploaded.certificate_filename,
        certificate_uploaded_at: new Date().toISOString(),
      })
      setCertificateFilename(uploaded.certificate_filename)
    } catch (err) {
      setCertError(err instanceof Error ? err.message : t('integrations.errors.save'))
    } finally {
      setUploadingCert(false)
    }
  }

  /** De varias resoluciones vigentes devueltas por la DIAN (poco común,
   * pero un NIT puede tener más de una activa a la vez para distintos
   * documentos), se queda con la que todavía no venció -- y entre esas, la
   * de vigencia más reciente. Si ninguna trae fecha parseable, se queda
   * con la primera tal cual vino -- mejor eso que no completar nada. */
  function pickActiveRange(ranges: DianNumberingRange[]): DianNumberingRange {
    const today = new Date().toISOString().slice(0, 10)
    const withParsedValidUntil = ranges.filter((r) => r.validUntil && !Number.isNaN(Date.parse(r.validUntil)))
    const stillValid = withParsedValidUntil.filter((r) => (r.validUntil as string).slice(0, 10) >= today)
    const pool = stillValid.length > 0 ? stillValid : withParsedValidUntil.length > 0 ? withParsedValidUntil : ranges
    return pool.reduce((best, r) => {
      if (!r.validFrom) return best
      if (!best.validFrom) return r
      return r.validFrom > best.validFrom ? r : best
    }, pool[0])
  }

  async function handleSyncResolution() {
    if (!tenantId) return
    setSyncingResolution(true)
    setResolutionSyncError(null)
    setResolutionSyncNote(null)
    try {
      const result = await syncDianNumberingRange(tenantId)
      if (result.faultReason) {
        setResolutionSyncError(result.faultReason)
        return
      }
      if (result.ranges.length === 0) {
        setResolutionSyncError(result.operationDescription ?? t('integrations.dianDirecto.syncNoRanges'))
        return
      }
      const chosen = pickActiveRange(result.ranges)
      if (chosen.prefix) setResolutionPrefix(chosen.prefix)
      if (chosen.resolutionNumber) setResolutionNumber(chosen.resolutionNumber)
      if (chosen.rangeFrom != null) setResolutionRangeFrom(String(chosen.rangeFrom))
      if (chosen.rangeTo != null) setResolutionRangeTo(String(chosen.rangeTo))
      if (chosen.validFrom) setResolutionValidFrom(chosen.validFrom.slice(0, 10))
      if (chosen.validUntil) setResolutionValidUntil(chosen.validUntil.slice(0, 10))
      // Bug real 2026-09-10: la sincronización traía `technicalKey` de la
      // DIAN (ver getNumberingRange.ts, GetNumberingRange sí lo devuelve por
      // rango) pero nunca lo volcaba al formulario -- el campo se quedaba con
      // lo que el usuario hubiera tipeado a mano (o el de habilitación, si
      // nunca lo actualizó al pasar a producción), lo que rechaza el CUFE
      // entero (FAD06) sin ningún aviso -- la DIAN no puede decir "tu clave
      // técnica está mal", solo que el hash no cierra. Ahora se precarga
      // igual que el resto de los campos de la resolución (sigue exigiendo
      // "Guardar cambios" para persistir, mismo criterio ya documentado).
      if (chosen.technicalKey) setTechnicalKey(chosen.technicalKey)
      setResolutionSyncNote(result.ranges.length > 1 ? t('integrations.dianDirecto.syncMultipleFound', { count: String(result.ranges.length) }) : t('integrations.dianDirecto.syncApplied'))
    } catch (err) {
      setResolutionSyncError(err instanceof Error ? err.message : t('integrations.dianDirecto.syncError'))
    } finally {
      setSyncingResolution(false)
    }
  }

  async function handleSubmit() {
    if (!tenantId) return
    setSubmitting(true)
    setError(null)
    try {
      if (certificatePassword.trim()) await setIntegrationCredentialSecret(PROVIDER_KEY, tenantId, 'certificate_password', certificatePassword.trim())
      if (technicalKey.trim()) await setIntegrationCredentialSecret(PROVIDER_KEY, tenantId, 'technical_key', technicalKey.trim())
      if (softwarePin.trim()) await setIntegrationCredentialSecret(PROVIDER_KEY, tenantId, 'software_pin', softwarePin.trim())

      const isConfigured = !!(resolutionNumber.trim() && resolutionPrefix.trim() && resolutionRangeFrom.trim() && resolutionRangeTo.trim())
      await updateTenantDianProfile(tenantId, {
        tax_enabled: taxEnabled,
        fiscal_regime: fiscalRegime || null,
        is_self_withholding_agent: isSelfWithholdingAgent,
        city: city.trim() || null,
        city_code: cityCode.trim() || null,
        state_code: stateCode.trim() || null,
        resolution_number: resolutionNumber.trim() || null,
        resolution_prefix: resolutionPrefix.trim() || null,
        resolution_range_from: resolutionRangeFrom.trim() ? Number(resolutionRangeFrom) : null,
        resolution_range_to: resolutionRangeTo.trim() ? Number(resolutionRangeTo) : null,
        resolution_valid_from: resolutionValidFrom || null,
        resolution_valid_until: resolutionValidUntil || null,
        software_id: softwareId.trim() || null,
        test_set_id: testSetId.trim() || null,
        webservice_url: webserviceUrl.trim() || null,
        credit_note_prefix: creditNotePrefix.trim() || null,
        is_configured: isConfigured,
      })

      const credential = await getIntegrationCredential(PROVIDER_KEY, tenantId)
      setConfiguredSecrets(credential ? await getIntegrationCredentialConfiguredSecrets(credential.id) : [])
      setCertificatePassword('')
      setTechnicalKey('')
      setSoftwarePin('')
      // Confirmación + cierre: el toast lo renderiza el ToastProvider en la
      // raíz, así que sigue en pantalla aunque este drawer ya se desmontó.
      toast.success(t('common.toast.saved'))
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('integrations.errors.save')
      // El error se muestra por partida doble a propósito: en el toast
      // (visible aunque el usuario esté mirando otra parte del formulario)
      // y en línea, porque el drawer NO se cierra cuando algo falla -- lo
      // que se escribió tiene que seguir ahí para poder corregirlo.
      setError(message)
      toast.error(t('common.toast.saveFailed'), message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleAddWithholding() {
    if (!tenantId || !newWithholdingType || !newWithholdingConcept.trim() || !newWithholdingRate.trim()) return
    try {
      const created = await createTenantWithholdingConfig(tenantId, {
        tax_type_code: newWithholdingType,
        concept: newWithholdingConcept.trim(),
        rate: Number(newWithholdingRate),
      })
      setWithholdingConfigs((prev) => [...prev, created])
      setNewWithholdingType('')
      setNewWithholdingConcept('')
      setNewWithholdingRate('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('integrations.errors.save'))
    }
  }

  async function handleRemoveWithholding(id: string) {
    try {
      await deleteTenantWithholdingConfig(id)
      setWithholdingConfigs((prev) => prev.filter((c) => c.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('integrations.errors.save'))
    }
  }

  const certificateConfigured = !!certificateFilename
  const passwordConfigured = configuredSecrets.includes('certificate_password')
  const connected = certificateConfigured && passwordConfigured

  return (
    <Drawer open={open} onClose={onClose} title={t('integrations.dianDirecto.title')} description={description} size="lg">
      {!loaded && !error && <p className="text-xs text-brand-400">{t('common.status.loading')}</p>}

      {loaded && (
        <div className="space-y-4">
          <div className="rounded-xl bg-brand-50/60 p-3">
            <p className="text-xs leading-snug text-brand-500">{t('integrations.dianDirecto.hint')}</p>
          </div>

          <IntegrationStatusBanner
            connected={connected}
            connectedText={t('integrations.dianDirecto.connected')}
            notConnectedText={t('integrations.dianDirecto.notConnected')}
          />

          <IntegrationSection title={t('integrations.dianDirecto.section.certificate')}>
            <div className="flex items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadingCert}>
                <UploadIcon width={14} height={14} />
                {certificateFilename ? t('integrations.dianDirecto.certificateReplace') : t('integrations.dianDirecto.certificateUpload')}
              </Button>
              {uploadingCert && <span className="text-xs text-brand-400">{t('common.status.loading')}</span>}
              {!uploadingCert && certificateFilename && (
                <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                  {certificateFilename}
                </Badge>
              )}
            </div>
            <input ref={fileInputRef} type="file" accept=".p12,.pfx" className="hidden" onChange={handleCertificateSelect} />
            {certError && <FieldError message={certError} />}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <IntegrationFieldLabel
                  htmlFor="dian-certificate-password"
                  label={t('integrations.dianDirecto.certificatePassword')}
                  badge={
                    passwordConfigured && (
                      <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                        {t('integrations.configured')}
                      </Badge>
                    )
                  }
                />
                <Input
                  id="dian-certificate-password"
                  type="password"
                  value={certificatePassword}
                  onChange={(e) => setCertificatePassword(e.target.value)}
                  placeholder={passwordConfigured ? t('integrations.replaceValue') : undefined}
                  autoComplete="off"
                  className={FIELD_CLASS}
                />
              </div>
              <div>
                <IntegrationFieldLabel
                  htmlFor="dian-technical-key"
                  label={t('integrations.dianDirecto.technicalKey')}
                  badge={
                    configuredSecrets.includes('technical_key') && (
                      <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                        {t('integrations.configured')}
                      </Badge>
                    )
                  }
                />
                <Input
                  id="dian-technical-key"
                  type="password"
                  value={technicalKey}
                  onChange={(e) => setTechnicalKey(e.target.value)}
                  placeholder={configuredSecrets.includes('technical_key') ? t('integrations.replaceValue') : undefined}
                  autoComplete="off"
                  className={FIELD_CLASS}
                />
              </div>
            </div>
            <div>
              <IntegrationFieldLabel
                htmlFor="dian-software-pin"
                label={t('integrations.dianDirecto.softwarePin')}
                badge={
                  configuredSecrets.includes('software_pin') && (
                    <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                      {t('integrations.configured')}
                    </Badge>
                  )
                }
              />
              <Input
                id="dian-software-pin"
                type="password"
                value={softwarePin}
                onChange={(e) => setSoftwarePin(e.target.value)}
                placeholder={configuredSecrets.includes('software_pin') ? t('integrations.replaceValue') : undefined}
                autoComplete="off"
                className={`sm:w-1/2 ${FIELD_CLASS}`}
              />
            </div>
          </IntegrationSection>

          <IntegrationSection title={t('integrations.dianDirecto.section.profile')}>
            <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
              <p className="text-xs font-medium text-brand-700">{t('integrations.dianDirecto.taxEnabled')}</p>
              <Switch checked={taxEnabled} onCheckedChange={setTaxEnabled} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <IntegrationFieldLabel htmlFor="dian-mode" label={t('integrations.mode')} />
                <Select value={mode} onValueChange={(v) => handleModeChange(v as 'sandbox' | 'production')}>
                  <SelectTrigger id="dian-mode" className={`w-full ${FIELD_CLASS}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sandbox" className="text-xs">
                      {t('integrations.dianDirecto.mode.habilitacion')}
                    </SelectItem>
                    <SelectItem value="production" className="text-xs">
                      {t('integrations.mode.production')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {mode === 'production' && (
                  <p className="mt-1 text-[10px] leading-tight text-amber-600">{t('integrations.dianDirecto.environmentHint')}</p>
                )}
              </div>
              <div>
                <IntegrationFieldLabel htmlFor="dian-fiscal-regime" label={t('integrations.dianDirecto.fiscalRegime')} />
                <Select value={fiscalRegime} onValueChange={(v) => setFiscalRegime(v as 'responsable_iva' | 'no_responsable_iva')}>
                  <SelectTrigger id="dian-fiscal-regime" className={`w-full ${FIELD_CLASS}`}>
                    <SelectValue placeholder={t('common.form.selectPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="responsable_iva" className="text-xs">
                      {t('integrations.dianDirecto.fiscalRegime.responsable')}
                    </SelectItem>
                    <SelectItem value="no_responsable_iva" className="text-xs">
                      {t('integrations.dianDirecto.fiscalRegime.noResponsable')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
              <p className="text-xs font-medium text-brand-700">{t('integrations.dianDirecto.selfWithholding')}</p>
              <Switch checked={isSelfWithholdingAgent} onCheckedChange={setIsSelfWithholdingAgent} />
            </div>

            <div>
              <IntegrationFieldLabel htmlFor="dian-software-id" label={t('integrations.dianDirecto.softwareId')} />
              <Input id="dian-software-id" value={softwareId} onChange={(e) => setSoftwareId(e.target.value)} className={`sm:w-1/2 ${FIELD_CLASS}`} />
            </div>

            {/* Departamento/ciudad elegidos de la lista real de la DIAN
                (DIVIPOLA) -- ya trae el código correcto, sin que nadie
                tenga que saberlo de memoria (antes era un campo de texto
                libre para el código, pedido explícito del usuario
                2026-09-09: "cargar eso a la base de datos"). `city` (el
                nombre legible que ya usaba el XML) se completa solo desde
                la elección -- ya no es un campo aparte. */}
            <GeoSelect
              stateCode={stateCode || null}
              cityCode={cityCode || null}
              onChange={({ stateCode: nextState, cityCode: nextCity, cityName }) => {
                setStateCode(nextState ?? '')
                setCityCode(nextCity ?? '')
                setCity(cityName ?? '')
              }}
              stateLabel={t('integrations.dianDirecto.state')}
              cityLabel={t('integrations.dianDirecto.city')}
              idPrefix="dian-geo"
            />

            <div className="grid gap-3 sm:grid-cols-2">
              {/* El Test Set ID solo aplica en habilitación -- en producción
                  la operación es SendBillAsync, que no lo recibe. El ambiente
                  lo decide el selector "Modo" de más arriba. */}
              {mode === 'sandbox' && (
                <div>
                  <IntegrationFieldLabel htmlFor="dian-test-set-id" label={t('integrations.dianDirecto.testSetId')} />
                  <Input id="dian-test-set-id" value={testSetId} onChange={(e) => setTestSetId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" className={FIELD_CLASS} />
                </div>
              )}
              <div>
                <IntegrationFieldLabel htmlFor="dian-webservice-url" label={t('integrations.dianDirecto.webserviceUrl')} />
                <Input id="dian-webservice-url" value={webserviceUrl} onChange={(e) => setWebserviceUrl(e.target.value)} placeholder={DIAN_HABILITACION_URL} className={FIELD_CLASS} />
              </div>
            </div>
          </IntegrationSection>

          <IntegrationSection
            title={t('integrations.dianDirecto.section.resolution')}
            action={
              <Button type="button" size="sm" variant="outline" onClick={handleSyncResolution} disabled={syncingResolution}>
                <RefreshCwIcon className="size-3.5" />
                {syncingResolution ? t('integrations.dianDirecto.syncing') : t('integrations.dianDirecto.sync')}
              </Button>
            }
          >
            {resolutionSyncError && <FieldError message={resolutionSyncError} />}
            {resolutionSyncNote && <p className="text-xs text-emerald-600">{resolutionSyncNote}</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <IntegrationFieldLabel htmlFor="dian-resolution-number" label={t('integrations.dianDirecto.resolutionNumber')} />
                <Input id="dian-resolution-number" value={resolutionNumber} onChange={(e) => setResolutionNumber(e.target.value)} className={FIELD_CLASS} />
              </div>
              <div>
                <IntegrationFieldLabel htmlFor="dian-resolution-prefix" label={t('integrations.dianDirecto.resolutionPrefix')} />
                <Input id="dian-resolution-prefix" value={resolutionPrefix} onChange={(e) => setResolutionPrefix(e.target.value)} className={FIELD_CLASS} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <IntegrationFieldLabel htmlFor="dian-resolution-from" label={t('integrations.dianDirecto.resolutionRangeFrom')} />
                <Input id="dian-resolution-from" type="number" value={resolutionRangeFrom} onChange={(e) => setResolutionRangeFrom(e.target.value)} className={FIELD_CLASS} />
              </div>
              <div>
                <IntegrationFieldLabel htmlFor="dian-resolution-to" label={t('integrations.dianDirecto.resolutionRangeTo')} />
                <Input id="dian-resolution-to" type="number" value={resolutionRangeTo} onChange={(e) => setResolutionRangeTo(e.target.value)} className={FIELD_CLASS} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <IntegrationFieldLabel htmlFor="dian-resolution-valid-from" label={t('integrations.dianDirecto.resolutionValidFrom')} />
                <Input id="dian-resolution-valid-from" type="date" value={resolutionValidFrom} onChange={(e) => setResolutionValidFrom(e.target.value)} className={FIELD_CLASS} />
              </div>
              <div>
                <IntegrationFieldLabel htmlFor="dian-resolution-valid-until" label={t('integrations.dianDirecto.resolutionValidUntil')} />
                <Input id="dian-resolution-valid-until" type="date" value={resolutionValidUntil} onChange={(e) => setResolutionValidUntil(e.target.value)} className={FIELD_CLASS} />
              </div>
            </div>
            {/* La DIAN no exige resolución autorizada para notas crédito
                (el consecutivo lo define el propio contribuyente) -- por
                eso es solo un prefijo suelto, sin rango ni vigencia. */}
            <div>
              <IntegrationFieldLabel htmlFor="dian-credit-note-prefix" label={t('integrations.dianDirecto.creditNotePrefix')} />
              <Input
                id="dian-credit-note-prefix"
                value={creditNotePrefix}
                onChange={(e) => setCreditNotePrefix(e.target.value)}
                placeholder={t('integrations.dianDirecto.creditNotePrefixPlaceholder')}
                className={`sm:w-1/2 ${FIELD_CLASS}`}
              />
            </div>
          </IntegrationSection>

          <IntegrationSection title={t('integrations.dianDirecto.section.withholding')}>
            {withholdingConfigs.length > 0 && (
              <div className="space-y-1.5">
                {withholdingConfigs.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-brand-100 px-2.5 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-brand-700">{taxTypes.find((t2) => t2.code === c.tax_type_code)?.name ?? c.tax_type_code}</span>
                      <span className="text-brand-400"> — {c.concept} ({c.rate}%)</span>
                    </span>
                    <button type="button" onClick={() => handleRemoveWithholding(c.id)} className="shrink-0 text-brand-300 hover:text-red-600" aria-label={t('common.actions.delete')}>
                      <TrashIcon width={14} height={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-[1fr_1fr_80px_auto] items-end gap-2">
              <div>
                <Select value={newWithholdingType} onValueChange={setNewWithholdingType}>
                  <SelectTrigger className={`w-full ${FIELD_CLASS}`}>
                    <SelectValue placeholder={t('integrations.dianDirecto.withholdingType')} />
                  </SelectTrigger>
                  <SelectContent>
                    {taxTypes.map((tx) => (
                      <SelectItem key={tx.code} value={tx.code} className="text-xs">
                        {tx.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Input
                value={newWithholdingConcept}
                onChange={(e) => setNewWithholdingConcept(e.target.value)}
                placeholder={t('integrations.dianDirecto.withholdingConcept')}
                className={FIELD_CLASS}
              />
              <Input type="number" value={newWithholdingRate} onChange={(e) => setNewWithholdingRate(e.target.value)} placeholder="%" className={FIELD_CLASS} />
              <Button type="button" size="sm" variant="outline" onClick={handleAddWithholding}>
                {t('common.actions.add')}
              </Button>
            </div>
          </IntegrationSection>

          {error && <FieldError message={error} />}

          <div className="flex items-center gap-2 border-t border-brand-100 pt-4">
            <Button type="button" onClick={handleSubmit} disabled={submitting}>
              {submitting ? t('common.actions.saving') : t('common.actions.save')}
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  )
}
