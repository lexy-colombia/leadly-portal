import { useEffect, useRef, useState } from 'react'
import { Button, InitialsAvatar, PageSpinner, Select, Switch } from '../../../components/ui'
import { ChevronLeftIcon, SendIcon } from '../../../components/icons'
import {
  conversationDisplayName,
  listMessages,
  sendHumanMessage,
  setConversationAssignee,
  setConversationCategory,
  setConversationMode,
  subscribeToMessages,
} from '../../../lib/api/conversations'
import type { ConversationWithLine } from '../../../lib/api/conversations'
import type { ConversationCategory, Profile, WhatsappMessage } from '../../../types/domain'
import { MessageBubble } from './MessageBubble'
import { useLanguage } from '../../../contexts/LanguageContext'

const CATEGORY_LABEL: Record<ConversationCategory, string> = {
  venta: 'Venta',
  soporte: 'Soporte',
  consulta: 'Consulta',
  reclamo: 'Reclamo',
  otro: 'Otro',
}

export function ChatPanel({
  conversation,
  agents,
  onBack,
}: {
  conversation: ConversationWithLine
  agents: Profile[]
  onBack: () => void
}) {
  const [messages, setMessages] = useState<WhatsappMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modeUpdating, setModeUpdating] = useState(false)
  const [categoryUpdating, setCategoryUpdating] = useState(false)
  const [assigneeUpdating, setAssigneeUpdating] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMessages(null)
    setError(null)
    listMessages(conversation.id)
      .then(setMessages)
      .catch((err) => setError(err.message ?? 'No se pudieron cargar los mensajes.'))

    const unsubscribe = subscribeToMessages(conversation.id, (message) => {
      setMessages((prev) => {
        if (!prev) return [message]
        if (prev.some((m) => m.id === message.id)) return prev
        return [...prev, message]
      })
    })
    return unsubscribe
  }, [conversation.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleModeToggle(checked: boolean) {
    const newMode = checked ? 'ia' : 'humano'
    setModeUpdating(true)
    setError(null)
    try {
      await setConversationMode(conversation.id, newMode)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cambiar el modo de la conversación.')
    } finally {
      setModeUpdating(false)
    }
  }

  async function handleCategoryChange(value: string) {
    setCategoryUpdating(true)
    setError(null)
    try {
      await setConversationCategory(conversation.id, (value || null) as ConversationCategory | null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cambiar el tipo de conversación.')
    } finally {
      setCategoryUpdating(false)
    }
  }

  async function handleAssigneeChange(value: string) {
    setAssigneeUpdating(true)
    setError(null)
    try {
      await setConversationAssignee(conversation.id, value || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo asignar la conversación.')
    } finally {
      setAssigneeUpdating(false)
    }
  }

  async function handleSend() {
    const content = draft.trim()
    if (!content || sending) return
    setSending(true)
    setError(null)
    try {
      const message = await sendHumanMessage(conversation.id, content)
      setMessages((prev) => {
        if (!prev) return [message]
        if (prev.some((m) => m.id === message.id)) return prev
        return [...prev, message]
      })
      setDraft('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar el mensaje.')
    } finally {
      setSending(false)
    }
  }

  const { t } = useLanguage()
  const name = conversationDisplayName(conversation)
  const isHumano = conversation.mode === 'humano'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2.5 border-b border-brand-100 bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onBack} className="-ml-1 p-1 text-brand-500 hover:text-brand-800 lg:hidden">
            <ChevronLeftIcon />
          </button>
          <InitialsAvatar name={name} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-brand-800">{name}</p>
            <p className="truncate text-xs text-brand-400">{conversation.contact_phone}</p>
          </div>
          <Switch
            checked={conversation.mode === 'ia'}
            onChange={handleModeToggle}
            disabled={modeUpdating}
            label={isHumano ? t('inbox.mode.humano') : t('inbox.mode.ia')}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Select
            value={conversation.category ?? ''}
            onChange={(e) => handleCategoryChange(e.target.value)}
            disabled={categoryUpdating}
            className="!w-auto !py-1.5 !text-xs"
          >
            <option value="">{t('inbox.category.unclassified')}</option>
            {(Object.keys(CATEGORY_LABEL) as ConversationCategory[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
          <Select
            value={conversation.assigned_agent_id ?? ''}
            onChange={(e) => handleAssigneeChange(e.target.value)}
            disabled={assigneeUpdating}
            className="!w-auto !py-1.5 !text-xs"
          >
            <option value="">{t('inbox.assignee.unassigned')}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.full_name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {error && <p className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</p>}

      <div className="flex-1 space-y-3 overflow-y-auto bg-[var(--color-surface)] px-4 py-4">
        {!messages && <PageSpinner />}
        {messages?.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-brand-100 bg-white p-3">
        {isHumano ? (
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              rows={1}
              placeholder={t('inbox.chat.messagePlaceholder')}
              className="max-h-32 flex-1 resize-none rounded-xl border border-brand-200 px-3 py-2.5 text-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500"
            />
            <Button onClick={handleSend} disabled={sending || !draft.trim()} className="!px-3.5 !py-2.5">
              <SendIcon width={16} height={16} />
            </Button>
          </div>
        ) : (
          <p className="rounded-xl bg-brand-50 px-3.5 py-2.5 text-center text-xs text-brand-400">
            {t('inbox.chat.aiRespondingHint')}
          </p>
        )}
      </div>
    </div>
  )
}
