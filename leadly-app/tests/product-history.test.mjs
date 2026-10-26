import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

let rows = []
let failAt = null
let ranges = []
let orders = []
globalThis.historyTestClient = { from() { return {
  select() { return this }, eq() { return this },
  order(...args) { orders.push(args); return this },
  range(from, to) { ranges.push([from,to]); return Promise.resolve({ data:rows.slice(from,to+1), error:from===failAt ? new Error('history failed') : null }) },
} } }
const source=(await readFile(new URL('../src/lib/api/stockMovements.ts',import.meta.url),'utf8')).replace("import { supabase } from '../supabaseClient'",'const supabase = globalThis.historyTestClient')
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {listMovementsForProduct,combineTransferHistory}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const movement=(id,extra={})=>({id:String(id),created_at:'2026-10-26T10:00:00Z',movement_type:'entrada',reference_type:null,reference_id:null,quantity:1,warehouse:{id:'w',name:'Main'},...extra})
function reset(input) {rows=input;ranges=[];orders=[];failAt=null}

test('complete history is not truncated at 20 or the backend response limit',async()=>{
 reset(Array.from({length:1003},(_,i)=>movement(i)))
 const result=await listMovementsForProduct('product')
 assert.equal(result.length,1003)
 assert.deepEqual(ranges,[[0,499],[500,999],[1000,1499]])
 assert.ok(orders.some(([key])=>key==='id'))
})
test('transfer spanning request boundaries remains one operation before display pagination',async()=>{
 reset([...Array.from({length:499},(_,i)=>movement(i)),movement(499,{movement_type:'transferencia_salida',reference_type:'transferencia',reference_id:'transfer'}),movement(500,{movement_type:'transferencia_entrada',reference_type:'transferencia',reference_id:'transfer'})])
 const entries=combineTransferHistory(await listMovementsForProduct('product'))
 assert.equal(entries.length,500)
 assert.equal(entries.filter(e=>e.kind==='transfer').length,1)
 const pages=Array.from({length:100},(_,i)=>entries.slice(i*5,(i+1)*5))
 assert.equal(pages.flat().filter(e=>e.kind==='transfer').length,1)
 assert.ok(pages.every(page=>page.length===5))
})
test('failure in a later request never returns a misleading partial history',async()=>{
 reset(Array.from({length:501},(_,i)=>movement(i)));failAt=500
 await assert.rejects(listMovementsForProduct('product'),/history failed/)
})
