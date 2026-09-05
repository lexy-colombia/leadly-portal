import { useEffect, useState, type ReactNode } from 'react'
import type { Client } from '../../../types/domain'
import type { TranslationKey } from '../../../i18n/translations'
import { formatClientPhoneDisplay } from '../../../lib/phone'
import { DOCUMENT_TYPES } from '../../../lib/referenceData'
import { useLanguage } from '../../../contexts/LanguageContext'
import { ContactDrawer } from './ContactDrawer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PencilIcon } from '@/components/atoms/icons'
import { XIcon } from 'lucide-react'

function documentLabel(client: Client, t: (key: TranslationKey) => string): string | null {
  if (!client.document_type && !client.document_number) return null
  const entry = DOCUMENT_TYPES.find((d) => d.value === client.document_type)
  const typeLabel = entry ? t(entry.labelKey) : null
  return [typeLabel, client.document_number].filter(Boolean).join(' ')
}

/** Tarjeta única para elegir/mostrar/crear/editar un cliente -- reemplaza dos
 * implementaciones que hacían lo mismo por separado (el bloque "Contacto" de
 * OrderDetail.tsx, y PosCustomerCard.tsx del POS), pedido explícito del
 * usuario para no mantener el mismo comportamiento en dos lugares.
 *
 * Antes, en los dos, el ícono para "elegir otro cliente" era un lápiz --
 * confundía "editar los datos de este cliente" con "cambiar a cuál cliente
 * apunta esto", que son acciones completamente distintas. Ahora son tres
 * acciones separadas y sin ambigüedad: lápiz = editar los datos del cliente
 * ya elegido (abre ContactDrawer en modo edición, sin salir de esta
 * pantalla); X = cambiar a otro cliente (abre el buscador); "+ Crear
 * cliente nuevo" dentro del buscador = alta rápida sin cambiar de pestaña
 * (mismo ContactDrawer, en modo creación).
 *
 * `onSearch` delega la fuente de candidatos a quien use el componente --
 * OrderDetail.tsx ya tiene la lista completa de contactos del tenant en
 * memoria (filtra ahí, sin red); el POS busca en vivo contra el servidor
 * (searchPosClients, la lista puede ser grande). No le importa a esta
 * tarjeta de dónde vienen los resultados. */
export function ClientPickerCard({
  tenantId,
  client,
  onSelect,
  onSearch,
  emptyLabel,
  allowClear = false,
  clearActionLabel,
  disabled = false,
  extra,
  bare = false,
  className = '',
}: {
  tenantId: string
  client: Client | null
  onSelect: (client: Client | null) => void
  onSearch: (query: string) => Promise<Client[]>
  /** Texto cuando no hay ningún cliente elegido -- "Consumidor Final" en el
   * POS, "Selecciona un cliente" en Órdenes. */
  emptyLabel: string
  /** El POS puede volver a "sin cliente" (consumidor final); un pedido
   * siempre necesita uno -- ahí no se ofrece esta opción. */
  allowClear?: boolean
  /** Etiqueta del botón de "volver a sin cliente", solo si allowClear. */
  clearActionLabel?: string
  disabled?: boolean
  /** Contenido opcional debajo de los datos base -- hoy solo el POS lo usa
   * para crédito/saldo a favor. */
  extra?: ReactNode
  /** Sin la tarjeta blanca propia (borde/fondo/padding) ni el encabezado
   * "Cliente" en h2 -- para cuando ya se embebe dentro de otra tarjeta con
   * su propio título (OrderDetail.tsx, sección "Cliente y direcciones"),
   * donde una tarjeta-dentro-de-tarjeta se veía redundante. Usa el mismo
   * componente `Label` que el resto de campos vecinos (Facturación/Envío)
   * en vez del h2, para que se vea como un campo más, no como otra sección. */
  bare?: boolean
  className?: string
}) {
  const { t } = useLanguage()
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Client[]>([])
  const [searching, setSearching] = useState(false)
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit' | null>(null)

  useEffect(() => {
    if (!searchOpen || query.trim().length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      onSearch(query)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, query])

  function pick(c: Client) {
    onSelect(c)
    setSearchOpen(false)
    setQuery('')
    setResults([])
  }

  return (
    <div className={bare ? className : `rounded-2xl border border-brand-100 bg-white p-3.5 ${className}`}>
      <div className={`flex items-center justify-between gap-2 ${bare ? '' : 'mb-2'}`}>
        {bare ? <Label>{t('contacts.picker.label')}</Label> : <h2 className="text-xs font-semibold text-brand-800">{t('contacts.picker.label')}</h2>}
        {!searchOpen && client && !disabled && (
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="icon-xs" onClick={() => setDrawerMode('edit')} aria-label={t('common.actions.edit')} title={t('common.actions.edit')}>
              <PencilIcon width={12} height={12} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setSearchOpen(true)}
              aria-label={t('contacts.picker.changeAria')}
              title={t('contacts.picker.changeAria')}
              className="text-brand-400 hover:text-red-600"
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        )}
      </div>

      {!searchOpen ? (
        <div className={bare ? 'mt-1' : ''}>
          <p className="truncate text-xs font-medium text-brand-800">{client?.full_name ?? emptyLabel}</p>
          {client && (
            <div className="mt-1.5 space-y-0.5 text-xs text-brand-400">
              {documentLabel(client, t) && <p className="truncate">{documentLabel(client, t)}</p>}
              <p className="truncate">{formatClientPhoneDisplay(client.phone_prefix, client.phone)}</p>
              {client.email && <p className="truncate">{client.email}</p>}
            </div>
          )}
          {extra}
          {!client && !disabled && (
            <button type="button" onClick={() => setSearchOpen(true)} className="mt-1.5 text-xs font-medium text-accent-600 hover:underline">
              {t('contacts.picker.selectAction')}
            </button>
          )}
        </div>
      ) : (
        <div className={bare ? 'mt-1' : ''}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('contacts.picker.searchPlaceholder')} autoFocus className="h-8 text-xs" />
          <div className="mt-2 max-h-48 divide-y divide-brand-100 overflow-y-auto rounded-lg border border-brand-100">
            {searching && <p className="px-3 py-2 text-xs text-brand-400">{t('contacts.picker.searching')}</p>}
            {!searching && query.trim().length >= 2 && results.length === 0 && <p className="px-3 py-2 text-xs text-brand-400">{t('contacts.picker.noResults')}</p>}
            {!searching &&
              results.map((c) => (
                <button key={c.id} type="button" onClick={() => pick(c)} className="block w-full px-3 py-2 text-left transition-colors hover:bg-accent-50">
                  <span className="block truncate text-xs font-medium text-brand-800">{c.full_name}</span>
                  <span className="block truncate text-[11px] text-brand-400">{c.document_number ?? formatClientPhoneDisplay(c.phone_prefix, c.phone)}</span>
                </button>
              ))}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <button type="button" onClick={() => setDrawerMode('create')} className="text-xs font-medium text-accent-600 hover:underline">
              + {t('contacts.picker.createAction')}
            </button>
            {allowClear ? (
              <button
                type="button"
                onClick={() => {
                  onSelect(null)
                  setSearchOpen(false)
                  setQuery('')
                }}
                className="text-xs font-medium text-brand-400 hover:text-brand-600"
              >
                {clearActionLabel}
              </button>
            ) : (
              client && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchOpen(false)
                    setQuery('')
                  }}
                  className="text-xs font-medium text-brand-400 hover:text-brand-600"
                >
                  {t('common.actions.cancel')}
                </button>
              )
            )}
          </div>
        </div>
      )}

      <ContactDrawer
        open={drawerMode !== null}
        onClose={() => setDrawerMode(null)}
        tenantId={tenantId}
        contact={drawerMode === 'edit' ? client : null}
        onSaved={(saved) => {
          onSelect(saved)
          setSearchOpen(false)
          setDrawerMode(null)
        }}
      />
    </div>
  )
}
