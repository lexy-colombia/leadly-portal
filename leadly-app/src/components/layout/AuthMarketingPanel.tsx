import { useLanguage } from '../../contexts/LanguageContext'
import { Logo } from '../brand/Logo'
import { BarChartIcon, ChatBubbleIcon, TargetIcon } from '../icons'

const FEATURES = [
  { icon: ChatBubbleIcon, titleKey: 'auth.marketing.feature1.title', descriptionKey: 'auth.marketing.feature1.description' },
  { icon: TargetIcon, titleKey: 'auth.marketing.feature2.title', descriptionKey: 'auth.marketing.feature2.description' },
  { icon: BarChartIcon, titleKey: 'auth.marketing.feature3.title', descriptionKey: 'auth.marketing.feature3.description' },
] as const

/** Left-hand marketing panel shared by every auth screen (login, forgot
 * password, etc.). The trend line is an inline SVG placeholder standing in
 * for a real illustration/photo -- swap the <TrendGraphic /> body for a
 * designed asset when one exists, the layout around it does not need to change. */
export function AuthMarketingPanel() {
  const { t } = useLanguage()

  return (
    <div className="relative hidden flex-col justify-between overflow-hidden bg-brand-800 p-10 text-white lg:flex lg:w-[46%] xl:p-14">
      <div>
        <Logo size="lg" onDark />
        <p className="mt-6 max-w-sm text-lg text-brand-100">
          {t('auth.marketing.heroPrefix')} <span className="font-semibold text-accent-400">{t('auth.marketing.heroHighlight')}</span>
        </p>
      </div>

      <ul className="space-y-6">
        {FEATURES.map(({ icon: Icon, titleKey, descriptionKey }) => (
          <li key={titleKey} className="flex gap-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/10 text-accent-400">
              <Icon width={20} height={20} />
            </span>
            <div>
              <p className="font-semibold text-white">{t(titleKey)}</p>
              <p className="text-sm text-brand-200">{t(descriptionKey)}</p>
            </div>
          </li>
        ))}
      </ul>

      <TrendGraphic />
    </div>
  )
}

function TrendGraphic() {
  const { t } = useLanguage()
  return (
    <div className="relative h-40">
      <svg viewBox="0 0 400 140" fill="none" className="h-full w-full" aria-hidden="true">
        <path
          d="M0 100 C 40 100, 55 60, 90 70 S 140 110, 180 90 S 230 30, 270 40 S 330 15, 400 10"
          stroke="var(--color-accent-400)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {[
          [90, 70],
          [180, 90],
          [270, 40],
          [400, 10],
        ].map(([cx, cy]) => (
          <circle key={cx} cx={cx} cy={cy} r="5" fill="white" stroke="var(--color-accent-400)" strokeWidth="2" />
        ))}
      </svg>
      <div className="absolute bottom-0 right-0 max-w-[13rem] rounded-xl border border-white/10 bg-brand-900/80 p-4 backdrop-blur">
        <p className="text-xl font-extrabold text-accent-400">+37%</p>
        <p className="text-sm font-medium text-white">{t('auth.marketing.trendLabel')}</p>
        <p className="text-xs text-brand-300">{t('auth.marketing.trendPeriod')}</p>
      </div>
    </div>
  )
}
