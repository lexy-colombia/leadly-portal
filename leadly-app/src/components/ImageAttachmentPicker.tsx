import { useEffect, useRef, useState } from 'react'
import { validatePqrAttachmentFile } from '../lib/api/attachments'
import { ImageIcon, XCircleIcon } from './icons'
import { Button } from './ui'

/** Optional "attach image" control shared by PqrDrawer (new PQR) and the
 * seguimiento composer in ContactoDetalle -- picks a file, previews it
 * locally (no upload yet), and hands the File up to the parent form. The
 * parent uploads it only after the PQR/seguimiento row itself is created,
 * since crm_attachments needs that row's id first. */
export function ImageAttachmentPicker({ file, onChange }: { file: File | null; onChange: (file: File | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  function handleSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!selected) return
    const validationError = validatePqrAttachmentFile(selected)
    if (validationError) {
      setError(validationError)
      return
    }
    setError(null)
    onChange(selected)
  }

  function handleClear() {
    setError(null)
    onChange(null)
  }

  if (file && previewUrl) {
    return (
      <div className="flex items-center gap-3">
        <img src={previewUrl} alt={file.name} className="h-14 w-14 rounded-lg object-cover" />
        <div className="min-w-0 flex-1 text-sm text-brand-600 truncate">{file.name}</div>
        <button type="button" onClick={handleClear} className="text-brand-400 hover:text-brand-600" aria-label="Quitar imagen">
          <XCircleIcon width={20} height={20} />
        </button>
      </div>
    )
  }

  return (
    <div>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleSelect} />
      <Button type="button" variant="ghost" onClick={() => inputRef.current?.click()}>
        <ImageIcon width={16} height={16} />
        Adjuntar imagen (opcional)
      </Button>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  )
}
