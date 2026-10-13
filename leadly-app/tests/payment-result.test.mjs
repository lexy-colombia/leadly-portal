import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// Transpila lib/api/paymentResult.ts (y sus dos dependencias puras) a un módulo ESM de prueba.
async function load() {
  const region = await readFile(new URL('../src/lib/functionsRegion.ts', import.meta.url), 'utf8')
  let src = await readFile(new URL('../src/lib/api/paymentResult.ts', import.meta.url), 'utf8')
  src = src.replace("import { resolveFunctionsRegion, withFunctionsRegion } from '../functionsRegion'", '').replaceAll('import.meta.env', 'globalThis.__env')
  const js = ts.transpileModule(`${region}\n${src}`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}
const api = await load()
const ID = '3f2b8c1e-9a4d-4e5f-8b6a-1c2d3e4f5a6b'

test('parsePaymentLinkId: solo UUID valido; nada de lo que agrega Wompi decide', () => {
  assert.equal(api.parsePaymentLinkId(ID), ID)
  assert.equal(api.parsePaymentLinkId(ID.toUpperCase()), ID)
  assert.equal(api.parsePaymentLinkId(`${ID}?id=12345-abc`), ID) // Wompi pego su ?id= sin separar
  assert.equal(api.parsePaymentLinkId(`${ID}&id=1`), ID)
  for (const bad of [null, undefined, '', 'abc', '123', `x${ID}`, ID.slice(0, 35), `${ID}0`, `${ID}-1`, "' or 1=1 --"]) {
    assert.equal(api.parsePaymentLinkId(bad), null, String(bad))
  }
})

test('parsePublicStatus: valores fuera del contrato caen a unknown/null; ignora campos extra', () => {
  assert.deepEqual(api.parsePublicStatus({ status: 'paid', last_attempt: 'APPROVED', updated_at: '2026-10-11T10:00:00Z', amount: 5 }), {
    status: 'paid', lastAttempt: 'APPROVED', updatedAt: '2026-10-11T10:00:00Z',
  })
  assert.deepEqual(api.parsePublicStatus({ status: 'hacked', last_attempt: 'PENDING' }), { status: 'unknown', lastAttempt: null, updatedAt: null })
  assert.deepEqual(api.parsePublicStatus(null), { status: 'unknown', lastAttempt: null, updatedAt: null })
  assert.deepEqual(api.parsePublicStatus('x'), { status: 'unknown', lastAttempt: null, updatedAt: null })
})

test('fetchPublicPaymentStatus: GET sin Authorization ni headers, sin credenciales, ruta publica', async () => {
  globalThis.__env = { VITE_SUPABASE_URL: 'https://proj.supabase.co/', VITE_SUPABASE_FUNCTIONS_REGION: 'auto' }
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ status: 'pending', last_attempt: 'DECLINED', updated_at: null }), { status: 200 })
  }
  const r = await api.fetchPublicPaymentStatus(ID)
  assert.deepEqual(r, { status: 'pending', lastAttempt: 'DECLINED', updatedAt: null })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `https://proj.supabase.co/functions/v1/payments-api/v1/public/payment-links/${ID}/status`)
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.credentials, 'omit')
  assert.equal(calls[0].init.headers, undefined)
})

test('fetchPublicPaymentStatus: error de red / HTTP no ok lanza (la pagina muestra Reintentar)', async () => {
  globalThis.__env = { VITE_SUPABASE_URL: 'https://proj.supabase.co', VITE_SUPABASE_FUNCTIONS_REGION: 'auto' }
  globalThis.fetch = async () => { throw new TypeError('offline') }
  await assert.rejects(() => api.fetchPublicPaymentStatus(ID), api.PaymentStatusRequestError)
  globalThis.fetch = async () => new Response('{}', { status: 500 })
  await assert.rejects(() => api.fetchPublicPaymentStatus(ID), api.PaymentStatusRequestError)
  globalThis.fetch = async () => new Response('no json', { status: 200 })
  await assert.rejects(() => api.fetchPublicPaymentStatus(ID), api.PaymentStatusRequestError)
})
