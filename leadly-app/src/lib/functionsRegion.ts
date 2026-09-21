// Fuerza la región de ejecución de las Edge Functions.
//
// La base de `leadly-portal` está en us-west-2, pero Supabase ejecuta cada
// función cerca de quien la llama (desde Colombia caía en us-east-1), así que
// cada consulta a la base cruzaba el país. Con `forceFunctionRegion` la
// función corre junto a la base.
//
// Se usa el query param y NO el header `x-region`: un header custom dispara
// un preflight CORS y `_shared/cors.ts` no lo permite (solo authorization,
// x-client-info, apikey, content-type). El query param no requiere cambios.
//
// Override: VITE_SUPABASE_FUNCTIONS_REGION. Vacío o "auto" = no fuerza nada.

export const DEFAULT_FUNCTIONS_REGION = 'us-west-2'

export function resolveFunctionsRegion(envValue: string | undefined): string | null {
  const value = (envValue ?? '').trim()
  if (value === '') return DEFAULT_FUNCTIONS_REGION
  if (value.toLowerCase() === 'auto') return null
  return value
}

function rewriteUrl(rawUrl: string, functionsPrefix: string, region: string): string | null {
  if (!rawUrl.startsWith(functionsPrefix)) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.searchParams.has('forceFunctionRegion')) return null
  url.searchParams.set('forceFunctionRegion', region)
  return url.toString()
}

export function withFunctionsRegion(
  input: RequestInfo | URL,
  supabaseUrl: string,
  region: string | null,
): RequestInfo | URL {
  if (!region) return input
  const prefix = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/`

  if (typeof input === 'string') return rewriteUrl(input, prefix, region) ?? input
  if (input instanceof URL) {
    const next = rewriteUrl(input.toString(), prefix, region)
    return next ? new URL(next) : input
  }
  // Request: `new Request(url, request)` conserva método, headers, body y signal.
  const next = rewriteUrl(input.url, prefix, region)
  return next ? new Request(next, input) : input
}
