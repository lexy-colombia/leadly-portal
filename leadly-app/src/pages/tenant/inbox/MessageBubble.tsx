import { AiSparkleIcon, UserIcon } from '../../../components/icons'
import type { WhatsappMessage } from '../../../types/domain'

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })
}

const SENDER_LABEL: Record<WhatsappMessage['sender_type'], string> = {
  contact: 'Contacto',
  ia: 'Asistente IA',
  agent: 'Agente',
}

export function MessageBubble({ message }: { message: WhatsappMessage }) {
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
            {SENDER_LABEL[message.sender_type]}
          </span>
        )}
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>
        {message.error_message && (
          <p className={`mt-1.5 text-[11px] ${isOutbound && !isIa ? 'text-red-200' : 'text-red-600'}`}>
            No se pudo entregar: {message.error_message}
          </p>
        )}
        <span className={`mt-1 block text-right text-[10px] ${isOutbound && !isIa ? 'text-brand-300' : 'text-brand-400'}`}>
          {formatTime(message.created_at)}
        </span>
      </div>
    </div>
  )
}
