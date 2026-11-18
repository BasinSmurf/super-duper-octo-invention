import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const source=readFileSync(new URL('./src/pages/RentalDetailPage.tsx',import.meta.url),'utf8')
const tree=ts.createSourceFile('RentalDetailPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX), parts=[]
function visit(node){if(ts.isFunctionDeclaration(node)&&['persistReturnedItem','completeAgreement','handleReturnItem'].includes(node.name?.text))parts.push(node.getText(tree));ts.forEachChild(node,visit)}
visit(tree)
const compiled=ts.transpileModule(parts.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
class ApiError extends Error { constructor(status,message){super(message);this.status=status} }
function harness(error){
 const requests=[],queues=[],updates=[],context={id:'rental',returnDate:'2026-10-10',agreement:{items:[{id:'unit',status:'deployed'}]},offlineEnabled:true,ApiError,Error,
  api:{patch:async(path,body)=>{requests.push({path,body});if(error)throw error}},
  db:{mutationQueue:{add:async value=>queues.push(value)},rentalAgreementItems:{update:async(id,data)=>updates.push({id,data})},rentalAgreements:{update:async(id,data)=>updates.push({id,data})},equipment:{update:async(id,data)=>updates.push({id,data})}},
  setReturningItem(){},loadAgreement:async()=>{},setError:value=>{context.error=value},setFinalBillReady:value=>{context.finalBillReady=value},
 }
 const actions=runInNewContext(`${compiled}; ({ persistReturnedItem, completeAgreement, handleReturnItem })`,context)
 return {context,requests,queues,updates,actions}
}
const item={id:'unit',serializedEquipmentId:'asset'},inspection={overallCondition:'good'}
test('Return All detail workflow uses the selected date for both equipment and closure without duplicate online mutations',async()=>{
 const h=harness();await h.actions.handleReturnItem(item,inspection)
 assert.equal(h.requests[0].body.returnedDate,'2026-10-10');assert.equal(h.requests[0].body.inspectionData,inspection)
 assert.equal(h.requests[1].body.endDate,'2026-10-10');assert.equal(h.queues.length,0);assert.equal(h.context.finalBillReady,true)
})
test('a validation conflict cannot mark equipment returned or show a false final-bill prompt',async()=>{
 const h=harness(new ApiError(409,'Return changes billed history'));await h.actions.handleReturnItem(item,inspection)
 assert.equal(h.updates.length,0);assert.equal(h.queues.length,0);assert.equal(h.context.finalBillReady,undefined);assert.equal(h.context.error,'Return changes billed history')
})
test('offline return retains the date and inspection for replay and waits to offer final billing',async()=>{
 const h=harness(new TypeError('offline'));await h.actions.handleReturnItem(item,inspection)
 assert.equal(h.queues.length,2);assert.equal(h.queues[0].payload.returnedDate,'2026-10-10');assert.equal(h.queues[0].payload.inspectionData,inspection)
 assert.equal(h.queues[1].payload.endDate,'2026-10-10');assert.equal(h.context.finalBillReady,false)
})
