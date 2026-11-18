import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const source = readFileSync(new URL('./src/lib/photoGps.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source.replace('export function', 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const read = runInNewContext(`${compiled}; photoGps`, { DataView, ArrayBuffer })
function jpeg(little) {
  const bytes = new Uint8Array(142), v = new DataView(bytes.buffer), base = 12
  v.setUint16(0, 0xffd8); v.setUint16(2, 0xffe1); v.setUint16(4, 136)
  bytes.set([69,120,105,102,0,0], 6)
  const u16 = (at, value) => v.setUint16(at, value, little)
  const u32 = (at, value) => v.setUint32(at, value, little)
  u16(base, little ? 0x4949 : 0x4d4d); u16(14,42); u32(16,8)
  u16(20,1); u16(22,0x8825); u16(24,4); u32(26,1); u32(30,26)
  u16(38,4)
  for (const [entry, tag, type, count, value] of [[40,1,2,2,0],[52,2,5,3,80],[64,3,2,2,0],[76,4,5,3,104]]) {
    u16(entry,tag); u16(entry+2,type); u32(entry+4,count); u32(entry+8,value)
  }
  bytes[48]=78; bytes[72]=87
  for (const [at, values] of [[92,[48,30,0]], [116,[103,15,0]]]) for (const [i,n] of values.entries()) { u32(at+i*8,n); u32(at+i*8+4,1) }
  v.setUint16(140,0xffd9)
  return bytes
}
for (const little of [true,false]) test(`reads original JPEG GPS with ${little ? 'little' : 'big'} endian metadata`, () => {
  const result=read(jpeg(little).buffer)
  assert.equal(result.latitude,48.5); assert.equal(result.longitude,-103.25)
})
test('rejects malformed offsets, truncated images and zero denominators', () => {
  assert.equal(read(new Uint8Array([255,216]).buffer),null)
  const bad=jpeg(true); new DataView(bad.buffer).setUint32(30,0xfffffff0,true); assert.equal(read(bad.buffer),null)
  const zero=jpeg(false); new DataView(zero.buffer).setUint32(96,0); assert.equal(read(zero.buffer),null)
})
