import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../../contexts/LanguageContext'
import { GlobeIcon } from '../icons'
import type { Language } from '../../i18n/translations'

const LABEL: Record<Language, string> = { es: 'Español', en: 'English' }

export function LanguageSwitcher() {
  const { language, setLanguage } = useLanguage()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-sm font-medium text-brand-500 transition-colors hover:bg-brand-50 hover:text-brand-800"
      >
        <GlobeIcon width={16} height={16} />
        {LABEL[language]}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-36 overflow-hidden rounded-xl border border-brand-100 bg-white py-1 shadow-lg">
          {(Object.keys(LABEL) as Language[]).map((lang) => (
            <button
              key={lang}
              type="button"
              onClick={() => {
                setLanguage(lang)
                setOpen(false)
              }}
              className={`flex w-full items-center px-3.5 py-2 text-left text-sm transition-colors ${
                lang === language ? 'font-semibold text-accent-700' : 'text-brand-600 hover:bg-brand-50'
              }`}
            >
              {LABEL[lang]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
