import { useId, useRef } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

/** Presentation-only image field; callers own upload, validation and persistence. */
export function ImageGalleryField({ images, label, addLabel, removeLabel, busy = false, compact = false, onAdd, onRemove }: {
  images: { id: string; src: string }[]
  label: string
  addLabel: string
  removeLabel: string
  compact?: boolean
  busy?: boolean
  onAdd: (files: File[]) => void
  onRemove: (id: string) => void
}) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  return <div className="flex flex-col gap-2">
    <Label className={compact ? 'sr-only' : undefined} htmlFor={inputId}>{label}</Label>
    <div className="flex flex-wrap gap-2">
      {images.map((image, index) => <div key={image.id} className={`relative rounded-md border border-border ${compact ? 'size-8' : 'size-14'}`}>
        <img src={image.src} alt={`${label} ${index + 1}`} className="size-full rounded-lg object-cover" />
        <Button type="button" size="icon-xs" variant="outline" aria-label={`${removeLabel} ${index + 1}`} disabled={busy} onClick={() => onRemove(image.id)} className="absolute -right-1 -top-1"><X /></Button>
      </div>)}
      <Button type="button" variant="outline" disabled={busy} onClick={() => inputRef.current?.click()} aria-label={addLabel} className={`border-dashed ${compact ? 'size-8' : 'size-14'}`}><Plus /></Button>
    </div>
    <input ref={inputRef} id={inputId} type="file" multiple accept="image/png,image/jpeg,image/webp" className="hidden" disabled={busy} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) onAdd(files) }} />
  </div>
}
