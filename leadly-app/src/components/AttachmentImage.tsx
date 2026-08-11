import { useEffect, useState } from 'react'
import { getAttachmentSignedUrl } from '../lib/api/attachments'
import { useLanguage } from '../contexts/LanguageContext'

/** Resolves a `crm-attachments` storage path into a short-lived signed URL
 * and renders it -- the bucket is private (see 20260804000019_crm_attachments
 * migration), so there's no public URL to just drop into an <img src>.
 * Click opens the full image in a new tab; no custom lightbox, kept simple. */
export function SignedImage({ storagePath, alt, className }: { storagePath: string; alt?: string; className?: string }) {
  const { t } = useLanguage()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setFailed(false)
    getAttachmentSignedUrl(storagePath)
      .then((signedUrl) => {
        if (!cancelled) setUrl(signedUrl)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [storagePath])

  if (failed) {
    return (
      <div className={`flex items-center justify-center rounded-lg bg-brand-50 text-xs text-brand-400 ${className ?? ''}`}>
        {t('common.attachment.notAvailable')}
      </div>
    )
  }
  if (!url) {
    return <div className={`animate-pulse rounded-lg bg-brand-100 ${className ?? ''}`} />
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block">
      <img src={url} alt={alt ?? t('common.attachment.image')} className={`rounded-lg object-cover ${className ?? ''}`} />
    </a>
  )
}
