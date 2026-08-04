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
      className={`flex w-full items-center gap-3 border-b border-brand-100/70 px-4 py-3 text-left transition-colors ${
        active ? 'bg-accent-50' : 'hover:bg-brand-50'
      }`}
    >
      <InitialsAvatar name={name} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-brand-800">{name}</span>
            {conversation.category && (
              <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-500">
                {CATEGORY_LABEL[conversation.category]}
              </span>
            )}
          </span>
          <span className="shrink-0 text-[11px] text-brand-400">{formatTime(conversation.last_message_at)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${conversation.mode === 'ia' ? 'bg-accent-500' : 'bg-amber-500'}`}
          />
          <span className="truncate text-xs text-brand-400">
            {conversation.mode === 'ia' ? t('inbox.mode.ia') : t('inbox.mode.humano')} · {conversation.whatsapp_line?.display_name ?? 'Línea'}
            {conversation.agent && <> · {conversation.agent.full_name}</>}
          </span>
        </span>
      </span>
    </button>
  )
}
