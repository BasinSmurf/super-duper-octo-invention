import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const source=readFileSync(new URL('./src/pages/TicketDetailPage.tsx',import.meta.url),'utf8'), tree=ts.createSourceFile('TicketDetailPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
let found
function visit(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='handleTransition')found=node;ts.forEachChild(node,visit)}visit(tree)
const compiled=ts.transpileModule(found.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
for(const answer of [null,'   '])test(`rejection ${answer===null?'cancel':'blank reason'} leaves ticket and outbox untouched`,async()=>{
 const writes=[],context={id:'t',ticket:{status:'supervisor_review'},navigator:{onLine:true},window:{prompt:()=>answer},setTransitioning(){},setTransitionError(){},setTicket:()=>writes.push('ui'),db:{tickets:{update:async()=>writes.push('cache')}},api:{post:async()=>writes.push('server')}}
 await runInNewContext(`${compiled}; handleTransition`,context)('in_progress');assert.deepEqual(writes,[])
})
