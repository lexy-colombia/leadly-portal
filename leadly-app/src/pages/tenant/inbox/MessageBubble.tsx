import { AiSparkleIcon, UserIcon } from '../../../components/icons'
import { SignedImage } from '../../../components/AttachmentImage'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey, Language } from '../../../i18n/translations'
import type { WhatsappMessage } from '../../../types/domain'

function formatTime(iso: string, language: Language): string {
  return new Date(iso).toLocaleTimeString(language === 'en' ? 'en-US' : 'es-CO', { hour: '2-digit', minute: '2-digit' })
}

// Placeholder content the webhook stores when a customer sends a photo with
// no caption (see whatsapp-webhook/index.ts) -- this is compared against the
// literal value written server-side (always Spanish, regardless of the
// viewer's language), so it must NOT be translated -- it's stored data, not
// UI copy.
const IMAGE_PLACEHOLDER_CONTENT = '[Imagen adjunta]'

const SENDER_LABEL_KEY: Record<WhatsappMessage['sender_type'], TranslationKey> = {
  contact: 'inbox.sender.contact',
  ia: 'inbox.sender.ai',
  agent: 'inbox.sender.agent',
}

export function MessageBubble({ message }: { message: WhatsappMessage }) {
  const { t, language } = useLanguage()
  const isOutbound = message.direction === 'outbound'
  const isIa = message.sender_type === 'ia'

  const bubbleClasses = isOutbound
    ? isIa
      ? 'bg-accent-50 text-brand-800 border border-accent-200'
      : 'bg-brand-700 text-white'
    : 'bg-white text-brand-800 border border-brand-100'

  return (
    <div className={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 shadow-sm sm:max-w-[65%] ${bubbleClasses}`}>
        {isOutbound && (
          <span
            className={`mb-1 flex items-center gap-1 text-[11px] font-semibold ${isIa ? 'text-accent-600' : 'text-brand-200'}`}
          >
            {isIa && <AiSparkleIcon width={12} height={12} />}
            {!isIa && <UserIcon width={12} height={12} />}
            {t(SENDER_LABEL_KEY[message.sender_type])}
          </span>
        )}
        {message.media_storage_path && (
          <SignedImage storagePath={message.media_storage_path} alt={t('inbox.image.sentByContact')} className="mb-1.5 max-h-64 w-full" />
        )}
        {!(message.media_storage_path && message.content === IMAGE_PLACEHOLDER_CONTENT) && (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>
        )}
        <span className={`mt-1 block text-right text-[10px] ${isOutbound && !isIa ? 'text-brand-300' : 'text-brand-400'}`}>
          {formatTime(message.created_at, language)}
        </span>
      </div>
    </div>
  )
}
