import { useLanguage } from '../contexts/LanguageContext'
import { Card } from '@/components/molecules'
export function ComingSoon() {
  const { t } = useLanguage()
  return (
    <div className="space-y-4">
      <Card>
        <p className="text-sm text-brand-500">{t('account.comingSoon.message')}</p>
      </Card>
    </div>
  )
}
