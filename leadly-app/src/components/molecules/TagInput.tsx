import { useState, type KeyboardEvent } from 'react'

/** Compact chip-based tag editor: type + Enter/comma adds a chip, click the
 * x (or backspace on an empty field) removes the last one. Replaces the old
 * "type comma-separated text" input -- same underlying `string[]` value,
 * just a nicer way to build it. */
export function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (tags: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('')

  function commitDraft() {
    const tag = draft.trim()
    setDraft('')
    if (!tag || value.includes(tag)) return
    onChange([...value, tag])
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // Also check keyCode/which -- some automated input paths (and a few
    // older/mobile browsers) don't populate `key` reliably.
    const isEnter = e.key === 'Enter' || e.keyCode === 13 || e.which === 13
    if (isEnter || e.key === ',') {
      e.preventDefault()
      commitDraft()
    } else if (e.key === 'Backspace' && !draft && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-brand-200 px-2.5 py-2 focus-within:border-accent-400 focus-within:ring-2 focus-within:ring-accent-400/60">
      {value.map((tag) => (
        <span key={tag} className="flex items-center gap-1 rounded-full bg-accent-50 py-1 pl-2.5 pr-1.5 text-xs font-medium text-accent-700">
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((t) => t !== tag))}
            aria-label={`Quitar ${tag}`}
            className="rounded-full p-0.5 text-accent-500 hover:bg-accent-100 hover:text-accent-800"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commitDraft}
        placeholder={value.length === 0 ? placeholder : undefined}
        className="min-w-[80px] flex-1 border-0 bg-transparent p-0.5 text-sm text-brand-800 placeholder:text-brand-300 focus:outline-none focus:ring-0"
      />
    </div>
  )
}
