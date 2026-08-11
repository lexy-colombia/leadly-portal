import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../../contexts/LanguageContext'
import { BellIcon, CalendarIcon, ChatBubbleIcon, UserIcon } from '../icons'

interface FakeNotification {
  id: string
  icon: 'message' | 'appointment' | 'contact'
  title: string
  detail: string
  time: string
  unread: boolean
}

const ICON_BY_TYPE = { message: ChatBubbleIcon, appointment: CalendarIcon, contact: UserIcon }

export function NotificationsBell({ theme = 'dark' }: { theme?: 'dark' | 'light' }) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const isLight = theme === 'light'

  // Placeholder feed -- there's no notifications backend yet (no table, no
  // realtime push), this is UI-only so the shell doesn't feel empty. Swap for
  // a real `notifications` table + subscription when that's built.
  const FAKE_NOTIFICATIONS: FakeNotification[] = [
    {
      id: '1',
      icon: 'message',
      title: t('common.notifications.demo.newMessage', { name: 'Camila Dussan' }),
      detail: t('common.notifications.demo.newMessageDetail'),
      time: t('common.notifications.demo.time.fiveMin'),
      unread: true,
    },
    {
      id: '2',
      icon: 'appointment',
      title: t('common.notifications.demo.appointmentTitle'),
      detail: 'Sebastian Avendaño (Dueño Lexy)',
      time: t('common.notifications.demo.time.twentyMin'),
      unread: true,
    },
    {
      id: '3',
      icon: 'contact',
      title: t('common.notifications.demo.newContact'),
      detail: t('common.notifications.demo.newContactDetail', { name: 'María Fernanda López' }),
      time: t('common.notifications.demo.time.twoHours'),
      unread: false,
    },
    {
      id: '4',
      icon: 'message',
      title: t('common.notifications.demo.humanMode'),
      detail: t('common.notifications.demo.humanModeDetail', { name: 'Carlos Ramirez' }),
      time: t('common.notifications.demo.time.yesterday'),
      unread: false,
    },
  ]
  const unreadCount = FAKE_NOTIFICATIONS.filter((n) => n.unread).length

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
        aria-label={t('common.notifications.title')}
        className={`relative rounded-full p-2 transition-colors ${
          isLight ? 'text-brand-500 hover:bg-brand-50 hover:text-brand-800' : 'text-brand-200 hover:bg-white/10 hover:text-white'
        }`}
      >
        <BellIcon width={19} height={19} />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-2 w-2 rounded-full bg-red-500 ring-2 ring-white" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-brand-100 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-brand-100 px-4 py-3">
            <p className="text-sm font-semibold text-brand-800">{t('common.notifications.title')}</p>
            {unreadCount > 0 && (
              <span className="text-xs font-medium text-accent-600">{t('common.notifications.unreadCount', { count: unreadCount })}</span>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {FAKE_NOTIFICATIONS.map((n) => {
              const Icon = ICON_BY_TYPE[n.icon]
              return (
                <div key={n.id} className={`flex gap-3 border-b border-brand-50 px-4 py-3 last:border-0 ${n.unread ? 'bg-accent-50/40' : ''}`}>
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-100 text-accent-700">
                    <Icon width={14} height={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-brand-800">{n.title}</p>
                    <p className="truncate text-xs text-brand-500">{n.detail}</p>
                    <p className="mt-0.5 text-[11px] text-brand-300">{n.time}</p>
                  </div>
                  {n.unread && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" />}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
