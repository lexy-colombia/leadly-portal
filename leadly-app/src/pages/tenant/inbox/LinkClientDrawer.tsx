import { useEffect, useState, type FormEvent } from 'react'
import { createClient, searchClients } from '../../../lib/api/clients'
import { linkConversationContact } from '../../../lib/api/conversations'
import type { Client } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { formatClientPhoneDisplay, splitPhone } from '../../../lib/phone'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

type Mode = 'existing' | 'new'

/** Links a conversation that came in without a client (see whatsapp-webhook:
 * it stopped auto-creating one per inbound number, since not every sender
 * is actually a client) to either an existing client (searched by name/
 * phone) or a brand new one, pre-filled with what WhatsApp already told us
 * about the sender. Same two-mode shape as NewConversationDrawer (existing/
 * new), just ending in "link" instead of "start a conversation". */
export function LinkClientDrawer({
  open,
  onClose,
  tenantId,
  conversationId,
  contactPhone,
  contactName,
  onLinked,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  conversationId: string
  contactPhone: string
  contactName: string | null
  onLinked: () => void
}) {
  const { t } = useLanguage()
  const [mode, setMode] = useState<Mode>('existing')
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Client[]>([])
  const [selected, setSelected] = useState<Client | null>(null)
  const [newName, setNewName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMode('existing')
    setSearch('')
    setResults([])
    setSelected(null)
    setNewName(contactName ?? '')
    setFormError(null)
  }, [open, contactName])

  // Debounced server-side search (see lib/api/clients.ts::searchClients) --
  // a tenant's client list can't be assumed small the way categories/brands
  // are, so this never loads the full list up front.
  useEffect(() => {
    if (!open || mode !== 'existing') return
    const timer = setTimeout(() => {
      searchClients(tenantId, search).then(setResults).catch(() => setResults([]))
    }, 250)
    return () => clearTimeout(timer)
  }, [open, mode, search, tenantId])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)

    if (mode === 'existing' && !selected) return

    setSubmitting(true)
    try {
      // contactPhone es whatsapp_conversations.contact_phone (número
      // completo, tabla no tocada por el split) -- se parte acá para las
      // dos columnas de clients.
      const { dialCode, localNumber } = splitPhone(contactPhone)
      const contactId =
        mode === 'existing'
          ? selected!.id
          : (
              await createClient({
                tenant_id: tenantId,
                full_name: newName.trim() || contactPhone,
                phone_prefix: dialCode,
                phone: localNumber,
                tags: [],
              })
            ).id
      await linkConversationContact(conversationId, contactId)
      onLinked()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('inbox.linkClient.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('inbox.linkClient.title')} description={t('inbox.linkClient.description')}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
          <TabsList className="w-full">
            <TabsTrigger value="existing" className="text-xs">
              {t('inbox.linkClient.tabs.existing')}
            </TabsTrigger>
            <TabsTrigger value="new" className="text-xs">
              {t('inbox.linkClient.tabs.new')}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {mode === 'existing' ? (
          <div>
            <div className="overflow-hidden rounded-lg border border-input">
              {/* shouldFilter=false -- results already come pre-filtered from
                  the server (searchClients), cmdk's own client-side filter
                  would just re-filter an already-narrow list against its
                  internal id-based `value`, which can hide valid rows. */}
              <Command shouldFilter={false}>
                <CommandInput value={search} onValueChange={setSearch} placeholder={t('inbox.linkClient.searchPlaceholder')} className="text-xs" />
                <CommandList className="max-h-48">
                  <CommandEmpty className="text-xs">{t('inbox.linkClient.noResults')}</CommandEmpty>
                  <CommandGroup>
                    {results.map((c) => (
                      <CommandItem key={c.id} value={c.id} onSelect={() => setSelected(c)} className="text-xs">
                        <span className="flex-1 truncate">{c.full_name}</span>
                        <span className="shrink-0 text-brand-400">{formatClientPhoneDisplay(c.phone_prefix, c.phone)}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </div>
            {selected && (
              <p className="mt-1.5 text-xs text-brand-500">
                {t('inbox.linkClient.selected', { name: selected.full_name })}
              </p>
            )}
          </div>
        ) : (
          <div>
            <Label htmlFor="link-client-name">{t('inbox.linkClient.fields.name')}</Label>
            <Input id="link-client-name" value={newName} onChange={(e) => setNewName(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            <p className="mt-1.5 text-xs text-brand-400">{t('inbox.linkClient.fields.phoneHint', { phone: contactPhone })}</p>
          </div>
        )}

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-4">
          <Button type="submit" disabled={submitting || (mode === 'existing' && !selected)}>
            {submitting ? t('common.actions.saving') : t('inbox.linkClient.submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
