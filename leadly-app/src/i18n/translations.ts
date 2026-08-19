import esAccount from './locales/es/account.json'
import esAuth from './locales/es/auth.json'
import esBackoffice from './locales/es/backoffice.json'
import esBilling from './locales/es/billing.json'
import esCalendar from './locales/es/calendar.json'
import esCampaigns from './locales/es/campaigns.json'
import esChangelog from './locales/es/changelog.json'
import esCommon from './locales/es/common.json'
import esContacts from './locales/es/contacts.json'
import esDashboard from './locales/es/dashboard.json'
import esInbox from './locales/es/inbox.json'
import esIntegrations from './locales/es/integrations.json'
import esInventory from './locales/es/inventory.json'
import esOpportunities from './locales/es/opportunities.json'
import esOrders from './locales/es/orders.json'
import esProducts from './locales/es/products.json'
import esSettings from './locales/es/settings.json'
import esTasks from './locales/es/tasks.json'
import esTemplates from './locales/es/templates.json'

import enAccount from './locales/en/account.json'
import enAuth from './locales/en/auth.json'
import enBackoffice from './locales/en/backoffice.json'
import enBilling from './locales/en/billing.json'
import enCalendar from './locales/en/calendar.json'
import enCampaigns from './locales/en/campaigns.json'
import enChangelog from './locales/en/changelog.json'
import enCommon from './locales/en/common.json'
import enContacts from './locales/en/contacts.json'
import enDashboard from './locales/en/dashboard.json'
import enInbox from './locales/en/inbox.json'
import enIntegrations from './locales/en/integrations.json'
import enInventory from './locales/en/inventory.json'
import enOpportunities from './locales/en/opportunities.json'
import enOrders from './locales/en/orders.json'
import enProducts from './locales/en/products.json'
import enSettings from './locales/en/settings.json'
import enTasks from './locales/en/tasks.json'
import enTemplates from './locales/en/templates.json'

export type Language = 'es' | 'en'

// Lightweight, hand-rolled i18n instead of pulling in a library (react-i18next
// etc.) -- the app only needs es/en today and a flat key->string dictionary
// per language is enough. Translations live in locales/<lang>/<module>.json,
// one file per page/feature, so it's obvious which file to touch when
// translating a given screen -- this file only merges them. Keys keep their
// module prefix (e.g. 'inbox.title') even though they're already scoped by
// filename, so `t('some.key')` call sites never had to change when this file
// was split up. `useTranslation()` falls back to the key itself if a
// translation is missing, so a partially-translated screen never crashes.
export const translations = {
  es: {
    ...esCommon,
    ...esAuth,
    ...esDashboard,
    ...esInbox,
    ...esIntegrations,
    ...esContacts,
    ...esOpportunities,
    ...esTasks,
    ...esCalendar,
    ...esCampaigns,
    ...esProducts,
    ...esInventory,
    ...esOrders,
    ...esBilling,
    ...esSettings,
    ...esTemplates,
    ...esBackoffice,
    ...esAccount,
    ...esChangelog,
  },
  en: {
    ...enCommon,
    ...enAuth,
    ...enDashboard,
    ...enInbox,
    ...enIntegrations,
    ...enContacts,
    ...enOpportunities,
    ...enTasks,
    ...enCalendar,
    ...enCampaigns,
    ...enProducts,
    ...enInventory,
    ...enOrders,
    ...enBilling,
    ...enSettings,
    ...enTemplates,
    ...enBackoffice,
    ...enAccount,
    ...enChangelog,
  },
} as const satisfies Record<Language, Record<string, string>>

export type TranslationKey = keyof (typeof translations)['es']
