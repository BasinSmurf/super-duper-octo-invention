import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function functionSource(name) {
  const source = readFileSync(new URL('./src/components/FitTestEditor.tsx', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('FitTestEditor.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(found)
  return ts.transpileModule(found, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}

test('fit-test people get distinct identities across page reloads', () => {
  const source = functionSource('createBlankRecord')
  const ids = new Set()
  for (let page = 0; page < 3; page++) {
    const create = runInNewContext(`${source}; createBlankRecord`, { uuidv4: randomUUID })
    for (let person = 0; person < 10; person++) {
      const record = create('Test employer')
      assert.equal(ids.has(record.id), false)
      ids.add(record.id)
      assert.equal(record.employerName, 'Test employer')
    }
  }
})

test('duplicating a person keeps a distinct identity and clears their reports and signature', () => {
  const source = functionSource('duplicateLast')
  const original = { id: randomUUID(), employeeName: 'Test person', resultFiles: [{ id: randomUUID() }], participantSignature: 'signature' }
  let updated
  runInNewContext(`${source}; duplicateLast()`, {
    records: [original], uuidv4: randomUUID, onChange: rows => { updated = rows }, setExpandedId: () => {},
  })
  assert.equal(updated.length, 2)
  assert.notEqual(updated[1].id, original.id)
  assert.equal(updated[1].resultFiles.length, 0)
  assert.equal(updated[1].participantSignature, null)
})
