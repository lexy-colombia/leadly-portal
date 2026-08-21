import { InitialsAvatar } from '@/components/atoms'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { Language } from '../../../i18n/translations'
import { formatDate } from '../../../lib/dates'
import { CONVERSATION_CATEGORY_KEY, conversationDisplayName, type ConversationWithLine } from '../../../lib/api/conversations'

function formatTime(iso: string | null, language: Language): string {
  if (!iso) return ''
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (!sameDay) return formatDate(iso)
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
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
  const { t, language } = useLanguage()
  const name = conversationDisplayName(conversation)
  const showUnreadBadge = conversation.mode === 'humano' && conversation.unread_count > 0
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
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] text-brand-400">{formatTime(conversation.last_message_at, language)}</span>
            {showUnreadBadge && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-none text-white">
                {conversation.unread_count > 99 ? '99+' : conversation.unread_count}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1">
            {!conversation.contact_id && (
              <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-600" title={t('inbox.chat.noClientLinked')}>
                {t('inbox.list.noClient')}
              </span>
            )}
            {conversation.category && (
              <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium leading-none text-brand-500">
                {t(CONVERSATION_CATEGORY_KEY[conversation.category])}
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
