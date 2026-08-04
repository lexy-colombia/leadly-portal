// WhatsApp Embedded Signup (Meta's "Conectar con WhatsApp" flow): lets a
// tenant connect their OWN WhatsApp Business Account to Leadly -- Meta bills
// *them* for conversations/templates, not Leadly, unlike the manual
// "superadmin adds the client's number under Leadly's own Business Manager"
// path used today. Requires the Meta Tech Provider App Review to be approved
// and an Embedded Signup Configuration created in the Meta App Dashboard
// (WhatsApp > Embedded Signup) -- see CLAUDE.md section 1 for status.
//
// Reference: https://developers.facebook.com/docs/whatsapp/embedded-signup

declare global {
  interface Window {
    FB?: {
      init: (params: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }) => void
      login: (
        callback: (response: { authResponse?: { code?: string }; status?: string }) => void,
        params: {
          config_id: string
          response_type: 'code'
          override_default_response_type: true
          extras?: { setup?: Record<string, unknown>; featureType?: string; sessionInfoVersion?: string }
        },
      ) => void
    }
    fbAsyncInit?: () => void
  }
}

const SDK_VERSION = 'v21.0'
const SDK_SRC = 'https://connect.facebook.net/es_LA/sdk.js'

let sdkLoadPromise: Promise<void> | null = null

function loadFacebookSdk(appId: string): Promise<void> {
  if (window.FB) return Promise.resolve()
  if (sdkLoadPromise) return sdkLoadPromise

  sdkLoadPromise = new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version: SDK_VERSION })
      resolve()
    }
    const script = document.createElement('script')
    script.src = SDK_SRC
    script.async = true
    script.defer = true
    script.onerror = () => reject(new Error('No se pudo cargar el SDK de Facebook.'))
    document.body.appendChild(script)
  })
  return sdkLoadPromise
}

export interface EmbeddedSignupResult {
  code: string
  wabaId: string | null
  phoneNumberId: string | null
}

/** Meta posts a `WA_EMBEDDED_SIGNUP` message to the window with the
 * waba_id/phone_number_id once the popup flow finishes -- FB.login's own
 * callback only gives us the OAuth `code`, so both have to be collected
 * together before the promise resolves. */
function waitForSignupData(timeoutMs: number): Promise<{ wabaId: string | null; phoneNumberId: string | null }> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        window.removeEventListener('message', handleMessage)
        resolve({ wabaId: null, phoneNumberId: null })
      }
    }, timeoutMs)

    function handleMessage(event: MessageEvent) {
      if (!event.origin.endsWith('facebook.com')) return
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
        if (data?.type === 'WA_EMBEDDED_SIGNUP' && data?.event === 'FINISH') {
          settled = true
          clearTimeout(timer)
          window.removeEventListener('message', handleMessage)
          resolve({ wabaId: data.data?.waba_id ?? null, phoneNumberId: data.data?.phone_number_id ?? null })
        }
      } catch {
        /* not a JSON message we care about */
      }
    }
    window.addEventListener('message', handleMessage)
  })
}

/** Opens Meta's WhatsApp Embedded Signup popup. Resolves with the OAuth code
 * (to be exchanged server-side, never in the browser -- that needs the App
 * Secret) plus the WABA/phone IDs Meta reports back via postMessage. */
export async function launchWhatsAppEmbeddedSignup(): Promise<EmbeddedSignupResult> {
  const appId = import.meta.env.VITE_META_APP_ID as string | undefined
  const configId = import.meta.env.VITE_META_WHATSAPP_CONFIG_ID as string | undefined

  if (!appId) throw new Error('Falta configurar VITE_META_APP_ID.')
  if (!configId) {
    throw new Error(
      'Falta VITE_META_WHATSAPP_CONFIG_ID. Se crea en Meta App Dashboard → WhatsApp → Embedded Signup, una vez aprobado el Tech Provider review.',
    )
  }

  await loadFacebookSdk(appId)

  const signupDataPromise = waitForSignupData(120_000)

  const code = await new Promise<string>((resolve, reject) => {
    window.FB!.login(
      (response) => {
        if (response.authResponse?.code) {
          resolve(response.authResponse.code)
        } else {
          reject(new Error('No se completó la conexión con WhatsApp.'))
        }
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
      },
    )
  })

  const { wabaId, phoneNumberId } = await signupDataPromise
  return { code, wabaId, phoneNumberId }
}
