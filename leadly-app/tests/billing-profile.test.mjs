import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function load(path) {
  const src = await readFile(new URL(`../src/lib/${path}`, import.meta.url), 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}
const bp = await load('billingProfile.ts')
const rb = await load('receiptBuyer.ts')

const complete = {
  legal_name: 'Acme SAS', document_type_code: '31', document_number: '800197268-4', email: 'a@b.co',
  tax_level_code: 'R-99-PN', address_line1: 'Calle 1', country: 'CO', city: 'Medellín', state_code: '05', city_code: '05001',
}

test('NIT 800197268 tiene DV 4 (ejemplo oficial DIAN)', () => {
  assert.equal(bp.nitCheckDigit('800197268'), 4)
  assert.equal(bp.nitCheckDigit('900108281'), 3)
})

test('perfil completo: nada falta', () => {
  assert.deepEqual(bp.billingProfileMissingKeys(complete), [])
})

test('perfil vacío: lista lo mismo que el servidor', () => {
  const m = bp.billingProfileMissingKeys({ legal_name: null, document_type_code: null, document_number: null, email: null, tax_level_code: '', address_line1: null, country: null, city: null, state_code: null, city_code: null })
  assert.deepEqual(m, ['legalName', 'documentType', 'documentNumber', 'taxLevel'])
})

test('NIT con DV equivocado y NIT mal formado; el correo ya no es faltante de emisión', () => {
  assert.deepEqual(bp.billingProfileMissingKeys({ ...complete, document_number: '800197268-9' }), ['validCheckDigit'])
  assert.deepEqual(bp.billingProfileMissingKeys({ ...complete, document_number: 'abc' }), ['validNit'])
  assert.deepEqual(bp.billingProfileMissingKeys({ ...complete, email: null }), [])
  assert.deepEqual(bp.billingProfileMissingKeys({ ...complete, email: 'sin-arroba' }), [])
})

test('domicilio: sin dirección no exige nada; con dirección CO exige DANE; país inválido', () => {
  assert.deepEqual(bp.billingProfileMissingKeys({ ...complete, address_line1: null, country: null, city: null, state_code: null, city_code: null }), [])
  assert.deepEqual(bp.billingProfileMissingKeys({ ...complete, state_code: null, city_code: null }), ['geo'])
  assert.deepEqual(bp.billingProfileMissingKeys({ ...complete, address_line1: ' ', }), ['addressLine'])
  assert.deepEqual(bp.billingProfileMissingKeys({ ...complete, country: 'OT', state_code: null, city_code: null }), ['country'])
})

test('tipo de organización según documento', () => {
  assert.equal(bp.organizationTypeForDocument('31'), '1')
  assert.equal(bp.organizationTypeForDocument('50'), '1')
  assert.equal(bp.organizationTypeForDocument('13'), '2')
  assert.equal(bp.organizationTypeForDocument(null), '2')
})

test('unicidad 23505', () => {
  assert.equal(bp.isUniqueViolation({ code: '23505' }), true)
  assert.equal(bp.isUniqueViolation(new Error('x')), false)
})

test('ticket: dirección de entrega solo si es domicilio; si no, el domicilio fiscal; nombre/doc del perfil', () => {
  const contact = { full_name: 'Ana', document_number: '1' }
  const ship = { line1: 'Cra 5', city: 'Cali', country: 'CO' }
  const profile = { legal_name: 'Acme SAS', document_number: '800', address_line1: 'Calle 1', city: 'Medellín', country: 'CO' }
  assert.deepEqual(rb.receiptBuyer({ contact, fulfillment_method: 'delivery', shipping_address: ship, billing_profile: profile }), { name: 'Acme SAS', document: '800', address: 'Cra 5, Cali, CO' })
  assert.equal(rb.receiptBuyer({ contact, fulfillment_method: 'on_site', shipping_address: ship, billing_profile: profile }).address, 'Calle 1, Medellín, CO')
  assert.deepEqual(rb.receiptBuyer({ contact, fulfillment_method: 'on_site', shipping_address: ship }), { name: 'Ana', document: '1', address: null })
  assert.equal(rb.receiptBuyer({ contact: null }), null)
})

const sd = await load('shippingDestination.ts')

test('destino puntual: se lee del snapshot solo si one_off y sin address_id', () => {
  assert.equal(sd.destinationFromSnapshot(null), null)
  assert.equal(sd.destinationFromSnapshot({ address_id: 'x', one_off: true, line1: 'a' }), null)
  assert.equal(sd.destinationFromSnapshot({ address_id: null, line1: 'a' }), null)
  const d = sd.destinationFromSnapshot({ address_id: null, one_off: true, line1: 'Cra 5', city: 'Cali', phone: ' ', frozen_at: 'x' })
  assert.equal(d.line1, 'Cra 5')
  assert.equal(d.city, 'Cali')
  assert.equal(d.phone, null)
})

test('destino puntual: payload recorta, omite vacíos y claves ajenas', () => {
  assert.deepEqual(sd.destinationPayload({ line1: ' Cra 5 ', city: '', country: 'CO', extra: 'x' }), { line1: 'Cra 5', country: 'CO' })
})

test('destino puntual: reglas del contrato para el guardado', () => {
  const oneOff = { line1: 'Cra 5' }
  // activo: se reenvía y NO va con shipping_address_id
  assert.deepEqual(sd.destinationFields({ delivery: true, shippingAddressId: '', oneOff }), { shipping_destination: { line1: 'Cra 5' } })
  assert.deepEqual(sd.destinationFields({ delivery: true, shippingAddressId: 'a1', oneOff }), { shipping_destination: { line1: 'Cra 5' } })
  // dirección guardada: sola
  assert.deepEqual(sd.destinationFields({ delivery: true, shippingAddressId: 'a1', oneOff: null }), { shipping_address_id: 'a1' })
  // vaciar: borra el puntual explícitamente
  assert.deepEqual(sd.destinationFields({ delivery: true, shippingAddressId: '', oneOff: null }), { shipping_address_id: null, shipping_destination: null })
  // no domicilio: limpia ambos
  assert.deepEqual(sd.destinationFields({ delivery: false, shippingAddressId: 'a1', oneOff }), { shipping_address_id: null, shipping_destination: null })
})

test('destino puntual: igualdad y texto', () => {
  assert.equal(sd.sameDestination({ line1: 'a ' }, { line1: 'a' }), true)
  assert.equal(sd.sameDestination({ line1: 'a' }, null), false)
  assert.equal(sd.formatDestination({ line1: 'Cra 5', city: 'Cali', state_province: 'Valle' }), 'Cra 5, Cali, Valle')
})

test('correo del formulario de perfiles: obligatorio y con formato válido; perfil viejo sin correo solo se avisa', () => {
  assert.equal(bp.isValidProfileEmail('a@b.co'), true)
  assert.equal(bp.isValidProfileEmail(' a@b.co '), true)
  assert.equal(bp.isValidProfileEmail(''), false)
  assert.equal(bp.isValidProfileEmail(null), false)
  assert.equal(bp.isValidProfileEmail('sin-arroba'), false)
  assert.equal(bp.profileHasNoEmail({ email: null }), true)
  assert.equal(bp.profileHasNoEmail({ email: '  ' }), true)
  assert.equal(bp.profileHasNoEmail({ email: 'a@b.co' }), false)
})
