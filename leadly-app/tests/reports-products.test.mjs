import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

process.env.TZ = 'America/Bogota'
const source = (await readFile(new URL('../src/lib/api/reports.ts', import.meta.url), 'utf8')).replace("import { supabase } from '../supabaseClient'", 'const supabase = globalThis.reportTestClient')
let input = []
let requestError = null
let requests = 0
const filters = []
globalThis.reportTestClient = { from() {
  let cursor = null
  let limit = 500
  return {
    select() { return this }, eq(...args) { filters.push(args); return this }, is() { return this },
    gte() { return this }, lt() { return this }, order() { return this }, abortSignal() { return this },
    gt(_column, value) { cursor = value; return this }, limit(value) { limit = value; return this },
    then(resolve, reject) { requests++; return Promise.resolve({data:input.filter((r) => !cursor || r.id>cursor).slice(0,limit),error:requestError}).then(resolve,reject) },
  }
} }
const compiled = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const { getSoldProducts } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const from = '2026-09-06T05:00:00.000Z'
const to = '2026-09-08T05:00:00.000Z'
function reset(rows) { input=rows;requests=0;requestError=null;filters.length=0 }
const row = (id, product, when='2026-09-06T12:00:00Z') => ({id:String(id).padStart(6,'0'),product_id:product,product_name:product??'Historical item',quantity:2,subtotal:100,sales_orders:{created_at:when}})

test('reads every keyset page and aggregates all 97 products without a ranking cap', async () => {
 reset(Array.from({length:1201},(_,i) => row(i+1,`product-${i%97}`)))
 const result=await getSoldProducts('tenant',from,to)
 assert.equal(requests,3)
 assert.equal(result.rows.length,97)
 assert.equal(result.rows.reduce((sum,r) => sum+r.quantity,0),2402)
 assert.equal(result.rows.reduce((sum,r) => sum+r.revenue,0),120100)
 assert.ok(filters.some(([column,value]) => column==='sales_orders.tenant_id'&&value==='tenant'))
})
test('buckets late-night sales in Colombia and includes zero-activity days without an extra closing day', async () => {
 reset([row(1,'a','2026-09-07T04:59:59Z')])
 const result=await getSoldProducts('tenant',from,to)
 assert.deepEqual(result.dailySeries,[{date:'2026-09-06',quantity:2,revenue:100},{date:'2026-09-07',quantity:0,revenue:0}])
})
test('retains historical products without IDs and aggregates matching names', async () => {
 reset([row(1,null),row(2,null)])
 const result=await getSoldProducts('tenant',from,to)
 assert.equal(result.rows.length,1)
 assert.equal(result.rows[0].quantity,4)
})
test('fails the report on a query error rather than reporting a partial total', async () => {
 reset([]); requestError=new Error('query unavailable')
 await assert.rejects(getSoldProducts('tenant',from,to),/query unavailable/)
})
test('honors cancellation without returning a partial report', async () => {
 reset([row(1,'a')]);const controller=new AbortController();controller.abort()
 await assert.rejects(getSoldProducts('tenant',from,to,controller.signal),{name:'AbortError'})
})
