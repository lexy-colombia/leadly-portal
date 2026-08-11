import { InitialsAvatar } from '../../../components/ui'
import { useLanguage } from '../../../contexts/LanguageContext'
import { conversationDisplayName, type ConversationWithLine } from '../../../lib/api/conversations'
import type { ConversationCategory } from '../../../types/domain'

const CATEGORY_LABEL: Record<ConversationCategory, string> = {
  venta: 'Venta',
  soporte: 'Soporte',
  consulta: 'Consulta',
  reclamo: 'Reclamo',
  otro: 'Otro',
}

function formatTime(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' })
}

export function ConversationListItem({
  conversation,
  active,
  onClick,
}: {
  conversation: ConversationWithLine
  active: boolean
  onClick: () => void
}) {
  const { t } = useLanguage()
  const name = conversationDisplayName(conversation)
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 border-b border-brand-100/70 px-3.5 py-2.5 text-left transition-colors ${
        active ? 'bg-accent-50' : 'hover:bg-brand-50'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${conversation.mode === 'ia' ? 'bg-accent-500' : 'bg-amber-500'}`}
      />
      <InitialsAvatar name={name} size="md" />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="block truncate text-sm font-medium text-brand-800">{name}</span>
          <span className="block truncate text-xs text-brand-400">
            {conversation.mode === 'ia' ? t('inbox.mode.ia') : t('inbox.mode.humano')}
            {conversation.agent && <> · {conversation.agent.full_name}</>}
            {conversation.whatsapp_line && <> · {conversation.whatsapp_line.display_name}</>}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[11px] text-brand-400">{formatTime(conversation.last_message_at)}</span>
          <span className="flex items-center gap-1">
            {conversation.category && (
              <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-brand-500">
                {CATEGORY_LABEL[conversation.category]}
              </span>
            )}
            {conversation.status === 'closed' && (
              <span className="rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-red-600">
                {t('inbox.status.closed')}
              </span>
            )}
          </span>
        </span>
      </span>
    </button>
  )
}
