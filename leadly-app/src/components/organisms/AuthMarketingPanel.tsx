import { useLanguage } from '@/contexts/LanguageContext'

/** Marketing artwork shared by auth screens; the form layout stays independent. */
export function AuthMarketingPanel() {
  const { t } = useLanguage()

  return (
    <aside className="relative hidden flex-col justify-between gap-7 min-h-[44rem] overflow-hidden bg-brand-800 p-8 text-white lg:flex lg:w-[46%] xl:p-10 2xl:p-14">
      <picture className="pointer-events-none absolute inset-0">
        <source media="(min-width: 1024px)" srcSet="/images/leadly-login-business.webp" />
        <img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" alt="" width={1024} height={1536} className="h-full w-full object-cover object-center" />
      </picture>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-linear-to-b from-brand-900/70 via-transparent to-brand-900/95" />

      <div className="relative">
        <div className="flex items-center justify-between gap-4">
          <p className="font-sans text-4xl font-extrabold tracking-tight">Leadly<span className="text-accent-400">.</span></p>
          <span className="text-[10px] font-medium tracking-wide text-brand-200">{t('auth.marketing.byLexy')}</span>
        </div>
        <p className="mt-8 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-accent-300">
          <span aria-hidden="true" className="h-px w-6 bg-accent-400" />
          {t('auth.marketing.eyebrow')}
        </p>
        <h2 className="mt-3 max-w-lg text-[clamp(2.25rem,3.5vw,3.75rem)] leading-[1.06] font-extrabold tracking-[-0.045em]">
          {t('auth.marketing.heroPrefix')}
          <span className="mt-1 block text-accent-300">{t('auth.marketing.heroHighlight')}</span>
        </h2>
        <p className="mt-4 max-w-sm text-sm leading-relaxed text-brand-100">{t('auth.marketing.subtitle')}</p>
      </div>

      <div className="relative mt-64">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent-200">{t('auth.marketing.imageEyebrow')}</p>
        <p className="mt-2 max-w-sm font-sans text-2xl leading-tight font-bold tracking-tight xl:text-3xl">{t('auth.marketing.imageHeadline')}</p>
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/20 pt-4 text-xs font-medium text-brand-100">
          <span>CRM</span>
          <span aria-hidden="true" className="h-1 w-1 rounded-full bg-accent-300" />
          <span>WhatsApp + IA</span>
          <span aria-hidden="true" className="h-1 w-1 rounded-full bg-accent-300" />
          <span>POS</span>
          <span aria-hidden="true" className="h-1 w-1 rounded-full bg-accent-300" />
          <span>{t('auth.marketing.connectedOperation')}</span>
        </div>
      </div>
    </aside>
  )
}
