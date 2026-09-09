import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables')
}

// Bug real reportado por el usuario: cuando el servidor deja de aceptar el
// JWT guardado (revocado/expirado sin refresh exitoso, usuario borrado,
// etc.) pero AuthContext todavía tiene un `session` local que "se ve"
// vigente, la app queda 100% trabada -- cada pantalla dispara su propio
// fetch, cada uno falla por separado con 401 ("Invalid session", lo
// devuelven ~18 Edge Functions siempre que `auth.getUser()` falla del lado
// del servidor) y cada uno queda mostrando su propio banner de error rojo
// sin que nada navegue a ningún lado ni cierre la sesión. No hay ningún
// interceptor global hoy -- 49 archivos de lib/api/ llaman a Supabase cada
// uno por su cuenta, sin punto común.
//
// Se agrega un `fetch` custom, pasado acá una sola vez, que intercepta
// TODO lo que el cliente de supabase-js manda (REST, RPC, Storage,
// Functions -- todos pasan por `global.fetch`, nunca por window.fetch
// directo, así que esto no toca ningún otro fetch de la app): un 401 acá
// SIEMPRE significa "el JWT no fue aceptado" (nunca "no tenés permiso",
// que en este proyecto siempre es 403 -- ver dian-submit/index.ts,
// pos-checkout/index.ts, etc.), así que dispara sign-out automático en vez
// de dejar que cada pantalla se rompa a su manera. Una vez que
// `supabase.auth.signOut()` resuelve, `onAuthStateChange` (AuthContext.tsx)
// deja `session` en null y el guard de rutas (`RequireAuth`) ya sabe
// redirigir a /login solo -- no hace falta tocar nada más.
//
// `signOutInFlight` deduplica ráfagas de 401 simultáneos (una pantalla
// típica dispara varios fetch en paralelo) en un solo signOut real, y se
// libera después para que una sesión futura pueda volver a activarlo si
// hace falta.
let signOutInFlight: Promise<void> | null = null

function triggerSessionSignOut(): void {
  if (signOutInFlight) return
  signOutInFlight = supabase.auth
    .signOut()
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      signOutInFlight = null
    })
}

async function fetchWithSessionGuard(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init)
  if (response.status === 401) triggerSessionSignOut()
  return response
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: { fetch: fetchWithSessionGuard },
})
