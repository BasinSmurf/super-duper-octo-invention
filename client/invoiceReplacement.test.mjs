import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const source=readFileSync(new URL('./src/components/InvoiceLineEditor.tsx',import.meta.url),'utf8')
const tree=ts.createSourceFile('InvoiceLineEditor.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX), parts=[]
function visit(node) { if(ts.isFunctionDeclaration(node)&&['updateLine','onProductSelect'].includes(node.name?.text))parts.push(node.getText(tree)); ts.forEachChild(node,visit) }
visit(tree)
const compiled=ts.transpileModule(parts.join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
function editor(overrides=[],taxExempt=false) {
 const context={lineItems:[{description:'Rental serial S1',quantity:2,rate:150,amount:300}],customerDescriptions:overrides,descriptionsLoading:false,descriptionError:'',taxExempt}
 context.onChange=items=>{context.lineItems=items}
 return { context, actions:runInNewContext(`${compiled}; ({ updateLine, onProductSelect })`,context) }
}
const product={id:'p1',partNumber:'123',qbItemListId:'QB1',qbItemFullName:'Monitor',name:'Monitor',defaultSellPrice:5,unitOfMeasure:'EA',isTaxable:true}
test('QB replacement uses this customer Alt Text and catalog pricing, then permits manual edits',()=>{
 const {context,actions}=editor([{qbItemListId:'QB1',description:'Customer wording'}])
 actions.onProductSelect(0,product)
 assert.equal(context.lineItems[0].description,'Customer wording'); assert.equal(context.lineItems[0].rate,5); assert.equal(context.lineItems[0].amount,10)
 actions.updateLine(0,{description:'Approved wording',rate:125})
 assert.equal(context.lineItems[0].description,'Approved wording'); assert.equal(context.lineItems[0].amount,250)
})
test('another customer/item override cannot replace the catalog wording',()=>{
 const {context,actions}=editor([{qbItemListId:'OTHER',description:'Wrong wording'}]); actions.onProductSelect(0,product)
 assert.equal(context.lineItems[0].description,'Monitor')
})

test('replacement defaults to the imported item tax flag while preserving customer exemptions',()=>{
 const {context,actions}=editor()
 actions.onProductSelect(0,product)
 assert.equal(context.lineItems[0].isTaxable,true)
 actions.onProductSelect(0,{...product,isTaxable:false})
 assert.equal(context.lineItems[0].isTaxable,false)
 const exempt=editor([],true)
 exempt.actions.onProductSelect(0,product)
 assert.equal(exempt.context.lineItems[0].isTaxable,false)
})
