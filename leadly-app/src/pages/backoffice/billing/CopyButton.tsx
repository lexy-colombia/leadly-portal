import { CheckIcon, CopyIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useLanguage } from '../../../contexts/LanguageContext'
import { useToast } from '../../../contexts/ToastContext'

/** Copia `value` al portapapeles; si el navegador lo rechaza avisa con un
 * toast de error (nunca falla en silencio -- un secreto que no se copió y
 * se da por copiado es peor que no tener botón). */
export function CopyButton({ value, label, iconOnly = false }: { value: string; label?: string; iconOnly?: boolean }) {
  const { t } = useLanguage()
  const toast = useToast()
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success(t('paymentLinks.copied'))
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('paymentLinks.copyFailed'))
    }
  }

  const text = label ?? t('paymentLinks.copy')
  return (
    <Button type="button" variant="outline" size={iconOnly ? 'icon-xs' : 'xs'} onClick={handleCopy} aria-label={iconOnly ? text : undefined} title={iconOnly ? text : undefined}>
      {copied ? <CheckIcon width={13} height={13} /> : <CopyIcon width={13} height={13} />}
      {!iconOnly && text}
    </Button>
  )
}
