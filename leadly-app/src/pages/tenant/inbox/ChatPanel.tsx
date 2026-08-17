import { useEffect, useRef, useState } from 'react'
import { Button, InitialsAvatar, Input, PageSpinner } from '@/components/atoms'
import { IconSelect } from '@/components/molecules'
import { ArchiveIcon, ChevronLeftIcon, ImageIcon, LockClosedIcon, PlusIcon, RefreshIcon, SendIcon, TagIcon, UserIcon, XCircleIcon } from '@/components/atoms/icons'
import {
  CONVERSATION_CATEGORY_KEY,
  conversationDisplayName,
  listMessages,
  retryAiResponse,
  sendHumanMessage,
  setConversationArchived,
  setConversationAssignee,
  setConversationCategory,
  setConversationMode,
  setConversationStatus,
  subscribeToMessages,
} from '../../../lib/api/conversations'
import {
  createConversationTag,
  deleteConversationTag,
  listConversationTags,
  listTagIdsForConversation,
  setConversationTags,
} from '../../../lib/api/conversationTags'
import { uploadChatImage, validatePqrAttachmentFile } from '../../../lib/api/attachments'
import type { ConversationWithLine } from '../../../lib/api/conversations'
import type { ConversationCategory, ConversationTag, Profile, WhatsappMessage } from '../../../types/domain'
import { MessageBubble } from './MessageBubble'
import { useAuth } from '../../../contexts/AuthContext'
import { useLanguage } from '../../../contexts/LanguageContext'

export function ChatPanel({
  conversation,
  agents,
  onBack,
}: {
  conversation: ConversationWithLine
  agents: Profile[]
  onBack: () => void
}) {
  const { t } = useLanguage()
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'tenant_admin'
  const [messages, setMessages] = useState<WhatsappMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modeUpdating, setModeUpdating] = useState(false)
  const [categoryUpdating, setCategoryUpdating] = useState(false)
  const [assigneeUpdating, setAssigneeUpdating] = useState(false)
  const [statusUpdating, setStatusUpdating] = useState(false)
  const [archivedUpdating, setArchivedUpdating] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [attachment, setAttachment] = useState<File | null>(null)
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState<string | null>(null)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const [tagCatalog, setTagCatalog] = useState<ConversationTag[]>([])
  const [assignedTagIds, setAssignedTagIds] = useState<string[]>([])
  const [tagsUpdating, setTagsUpdating] = useState(false)
  const [tagsPopoverOpen, setTagsPopoverOpen] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [creatingTag, setCreatingTag] = useState(false)
  const [deletingTagId, setDeletingTagId] = useState<string | null>(null)
  const [tagCatalogError, setTagCatalogError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const tagsPopoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setAttachment(null)
    setAttachmentError(null)
  }, [conversation.id])

  useEffect(() => {
    if (!attachment) {
      setAttachmentPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(attachment)
    setAttachmentPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [attachment])

  useEffect(() => {
    setMessages(null)
    setError(null)
    listMessages(conversation.id)
      .then(setMessages)
      .catch((err) => setError(err.message ?? t('inbox.errors.loadMessages')))

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

  useEffect(() => {
    listConversationTags(conversation.tenant_id).then(setTagCatalog).catch(() => {})
    listTagIdsForConversation(conversation.id).then(setAssignedTagIds).catch(() => {})
  }, [conversation.id, conversation.tenant_id])

  useEffect(() => {
    if (!tagsPopoverOpen) return
    function handleClick(e: MouseEvent) {
      if (tagsPopoverRef.current && !tagsPopoverRef.current.contains(e.target as Node)) setTagsPopoverOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [tagsPopoverOpen])

  async function handleModeToggle(checked: boolean) {
    const newMode = checked ? 'ia' : 'humano'
    setModeUpdating(true)
    setError(null)
    try {
      await setConversationMode(conversation.id, newMode)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inbox.errors.changeMode'))
    } finally {
      setModeUpdating(false)
    }
  }

  const [retrySuccess, setRetrySuccess] = useState(false)

  async function handleRetryAi() {
    setRetrying(true)
    setRetrySuccess(false)
    setError(null)
    try {
      await retryAiResponse(conversation.id)
      setRetrySuccess(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inbox.errors.retryAi'))
    } finally {
      setRetrying(false)
    }
  }

  async function handleCategoryChange(value: string) {
    setCategoryUpdating(true)
    setError(null)
    try {
      await setConversationCategory(conversation.id, (value || null) as ConversationCategory | null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inbox.errors.changeCategory'))
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
      setError(err instanceof Error ? err.message : t('inbox.errors.assign'))
    } finally {
      setAssigneeUpdating(false)
    }
  }

  async function handleStatusToggle() {
    const nextStatus = conversation.status === 'open' ? 'closed' : 'open'
    setStatusUpdating(true)
    setError(null)
    try {
      await setConversationStatus(conversation.id, nextStatus)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inbox.errors.changeStatus'))
    } finally {
      setStatusUpdating(false)
    }
  }

  async function handleArchiveToggle() {
    const nextArchived = !conversation.archived_at
    setArchivedUpdating(true)
    setError(null)
    try {
      await setConversationArchived(conversation.id, nextArchived)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inbox.errors.archive'))
    } finally {
      setArchivedUpdating(false)
    }
  }

  async function handleToggleTag(tagId: string) {
    const nextTagIds = assignedTagIds.includes(tagId) ? assignedTagIds.filter((id) => id !== tagId) : [...assignedTagIds, tagId]
    setAssignedTagIds(nextTagIds)
    setTagsUpdating(true)
    setError(null)
    try {
      await setConversationTags(conversation.id, nextTagIds)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inbox.errors.updateTags'))
      listTagIdsForConversation(conversation.id).then(setAssignedTagIds).catch(() => {})
    } finally {
      setTagsUpdating(false)
    }
  }

  // Tag catalog management (create/delete) lives here, admin-only, instead
  // of a separate Configuración screen -- this is the only place tags
  // actually get used (assigned to a conversation), so managing the
  // catalog where you use it beats a settings page with no visual
  // connection to it (2026-08-16, explicit user request).
  async function handleCreateTag(e: React.FormEvent) {
    e.preventDefault()
    const name = newTagName.trim()
    if (!name) return
    setCreatingTag(true)
    setTagCatalogError(null)
    try {
      const tag = await createConversationTag(conversation.tenant_id, name)
      setTagCatalog((prev) => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)))
      setNewTagName('')
    } catch (err) {
      setTagCatalogError(err instanceof Error ? err.message : t('inbox.tags.errors.create'))
    } finally {
      setCreatingTag(false)
    }
  }

  async function handleDeleteTag(tagId: string) {
    setDeletingTagId(tagId)
    setTagCatalogError(null)
    try {
      await deleteConversationTag(tagId)
      setTagCatalog((prev) => prev.filter((tag) => tag.id !== tagId))
      setAssignedTagIds((prev) => prev.filter((id) => id !== tagId))
    } catch (err) {
      setTagCatalogError(err instanceof Error ? err.message : t('inbox.tags.errors.delete'))
    } finally {
      setDeletingTagId(null)
    }
  }

  function handleAttachmentSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!file) return
    const validationError = validatePqrAttachmentFile(file)
    if (validationError) {
      setAttachmentError(t(validationError))
      return
    }
    setAttachmentError(null)
    setAttachment(file)
  }

  async function handleSend() {
    const content = draft.trim()
    if ((!content && !attachment) || sending) return
    setSending(true)
    setError(null)
    try {
      const media = attachment ? await uploadChatImage(conversation.tenant_id, attachment) : undefined
      const message = await sendHumanMessage(conversation.id, content, media)
      setMessages((prev) => {
        if (!prev) return [message]
        if (prev.some((m) => m.id === message.id)) return prev
        return [...prev, message]
      })
      setDraft('')
      setAttachment(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inbox.errors.sendMessage'))
    } finally {
      setSending(false)
    }
  }

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
            <p className="truncate text-xs text-brand-400">
              {conversation.contact_phone}
              {conversation.whatsapp_line && <> · {conversation.whatsapp_line.display_name}</>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1 rounded-full bg-brand-50 p-0.5 text-xs font-medium">
            <button
              type="button"
              onClick={() => !modeUpdating && conversation.mode !== 'ia' && handleModeToggle(true)}
              disabled={modeUpdating}
              className={`rounded-full px-3 py-1.5 transition-colors ${
                conversation.mode === 'ia' ? 'bg-accent-500 text-white shadow-sm' : 'text-brand-400 hover:text-brand-700'
              }`}
            >
              {t('inbox.mode.ia')}
            </button>
            <button
              type="button"
              onClick={() => !modeUpdating && conversation.mode !== 'humano' && handleModeToggle(false)}
              disabled={modeUpdating}
              className={`rounded-full px-3 py-1.5 transition-colors ${
                conversation.mode === 'humano' ? 'bg-amber-500 text-white shadow-sm' : 'text-brand-400 hover:text-brand-700'
              }`}
            >
              {t('inbox.mode.humano')}
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <IconSelect
            icon={<TagIcon width={13} height={13} />}
            aria-label={t('inbox.category.ariaLabel')}
            value={conversation.category ?? ''}
            onChange={(e) => handleCategoryChange(e.target.value)}
            disabled={categoryUpdating}
            className="!w-auto !rounded-full !border-brand-200 !py-1.5 !pr-7 !text-xs hover:!border-brand-300"
          >
            <option value="">{t('inbox.category.unclassified')}</option>
            {(Object.keys(CONVERSATION_CATEGORY_KEY) as ConversationCategory[]).map((c) => (
              <option key={c} value={c}>
                {t(CONVERSATION_CATEGORY_KEY[c])}
              </option>
            ))}
          </IconSelect>
          <IconSelect
            icon={<UserIcon width={13} height={13} />}
            aria-label={t('inbox.assignee.ariaLabel')}
            value={conversation.assigned_agent_id ?? ''}
            onChange={(e) => handleAssigneeChange(e.target.value)}
            disabled={assigneeUpdating}
            className="!w-auto !rounded-full !border-brand-200 !py-1.5 !pr-7 !text-xs hover:!border-brand-300"
          >
            <option value="">{t('inbox.assignee.unassigned')}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.full_name}
              </option>
            ))}
          </IconSelect>

          <div ref={tagsPopoverRef} className="relative">
            <button
              type="button"
              onClick={() => setTagsPopoverOpen((o) => !o)}
              className={`flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                assignedTagIds.length > 0 ? 'border-accent-300 bg-accent-50 text-accent-700' : 'border-brand-200 text-brand-600 hover:bg-brand-50'
              }`}
            >
              <TagIcon width={13} height={13} />
              {t('inbox.tags.label')}
              {assignedTagIds.length > 0 && <span className="text-[10px]">({assignedTagIds.length})</span>}
            </button>

            {tagsPopoverOpen && (
              <div className="absolute left-0 top-full z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-2xl border border-brand-100 bg-white p-3 shadow-lg">
                <div className="space-y-1">
                  {tagCatalog.length === 0 ? (
                    <p className="px-1 py-1 text-xs text-brand-400">{t('inbox.tags.empty')}</p>
                  ) : (
                    tagCatalog.map((tag) => (
                      <div key={tag.id} className="flex items-center gap-1 rounded-lg pr-1 hover:bg-brand-50">
                        <label className="flex flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-sm text-brand-700">
                          <input
                            type="checkbox"
                            checked={assignedTagIds.includes(tag.id)}
                            onChange={() => handleToggleTag(tag.id)}
                            disabled={tagsUpdating}
                            className="h-3.5 w-3.5 rounded border-brand-300 text-accent-500 focus:ring-accent-400"
                          />
                          {tag.name}
                        </label>
                        {isAdmin && (
                          <button
                            type="button"
                            onClick={() => handleDeleteTag(tag.id)}
                            disabled={deletingTagId === tag.id}
                            aria-label={t('inbox.tags.deleteAria', { name: tag.name })}
                            className="shrink-0 rounded-full p-1 text-brand-300 transition-colors hover:bg-brand-100 hover:text-red-600 disabled:opacity-50"
                          >
                            <XCircleIcon width={12} height={12} />
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>

                {isAdmin && (
                  <form onSubmit={handleCreateTag} className="mt-2 flex gap-1.5 border-t border-brand-100 pt-2">
                    <Input
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      placeholder={t('inbox.tags.placeholder')}
                      className="!py-1 !text-xs"
                    />
                    <Button type="submit" variant="secondary" disabled={creatingTag || !newTagName.trim()} className="!shrink-0 !px-2 !py-1 !text-xs">
                      <PlusIcon width={12} height={12} />
                    </Button>
                  </form>
                )}
                {tagCatalogError && <p className="mt-1.5 px-1 text-xs text-red-600">{tagCatalogError}</p>}
              </div>
            )}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {conversation.status === 'open' && conversation.mode === 'ia' && (
              <Button variant="ghost" onClick={handleRetryAi} disabled={retrying} className="!px-3 !py-1.5 !text-xs">
                <RefreshIcon width={13} height={13} />
                {retrying ? t('inbox.retryAi.retrying') : t('inbox.retryAi.action')}
              </Button>
            )}
            <Button variant="ghost" onClick={handleArchiveToggle} disabled={archivedUpdating} className="!px-3 !py-1.5 !text-xs">
              <ArchiveIcon width={13} height={13} />
              {conversation.archived_at ? t('inbox.archive.unarchiveAction') : t('inbox.archive.archiveAction')}
            </Button>
            <Button
              variant={conversation.status === 'open' ? 'ghost' : 'secondary'}
              onClick={handleStatusToggle}
              disabled={statusUpdating}
              className="!px-3 !py-1.5 !text-xs"
            >
              <LockClosedIcon width={13} height={13} />
              {conversation.status === 'open' ? t('inbox.status.closeAction') : t('inbox.status.reopenAction')}
            </Button>
          </div>
        </div>
      </div>

      {error && <p className="border-b border-red-100 bg-red-50 px-4 py-2 text-xs text-red-700">{error}</p>}
      {retrySuccess && (
        <p className="border-b border-emerald-100 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">{t('inbox.retryAi.success')}</p>
      )}

      <div className="flex-1 space-y-3 overflow-y-auto bg-[var(--color-surface)] px-4 py-4">
        {!messages && <PageSpinner />}
        {messages?.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-brand-100 bg-white p-3">
        {conversation.status === 'closed' ? (
          <p className="rounded-xl bg-brand-50 px-3.5 py-2.5 text-center text-xs text-brand-400">{t('inbox.chat.closedHint')}</p>
        ) : isHumano ? (
          <div className="space-y-2">
            {attachmentError && <p className="text-xs text-red-600">{attachmentError}</p>}
            {attachment && attachmentPreviewUrl && (
              <div className="flex items-center gap-2 rounded-xl border border-brand-100 bg-brand-50/60 px-3 py-2">
                <img src={attachmentPreviewUrl} alt={attachment.name} className="h-12 w-12 rounded-lg object-cover" />
                <span className="min-w-0 flex-1 truncate text-xs text-brand-500">{attachment.name}</span>
                <button type="button" onClick={() => setAttachment(null)} className="text-brand-400 hover:text-brand-600" aria-label={t('common.attachment.remove')}>
                  <XCircleIcon width={18} height={18} />
                </button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <input ref={attachmentInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleAttachmentSelect} />
              <button
                type="button"
                onClick={() => attachmentInputRef.current?.click()}
                className="flex shrink-0 items-center justify-center rounded-xl border border-brand-200 p-2.5 text-brand-500 transition-colors hover:border-brand-300 hover:bg-brand-50"
                aria-label={t('common.attachment.attach')}
              >
                <ImageIcon width={18} height={18} />
              </button>
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
              <Button onClick={handleSend} disabled={sending || (!draft.trim() && !attachment)} className="!px-3.5 !py-2.5">
                <SendIcon width={16} height={16} />
              </Button>
            </div>
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
