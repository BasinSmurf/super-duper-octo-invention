/** Read JPEG GPS metadata before canvas compression discards EXIF. Untrusted offsets are bounds checked. */
export function photoGps(buffer: ArrayBuffer): { latitude: number; longitude: number } | null {
  try {
    const view = new DataView(buffer)
    if (view.getUint16(0) !== 0xffd8) return null
    let segment = 2
    while (segment + 4 <= view.byteLength) {
      const marker = view.getUint16(segment)
      if (marker === 0xffda || marker === 0xffd9) break
      const size = view.getUint16(segment + 2)
      const end = segment + 2 + size
      if (size < 2 || end > view.byteLength) return null
      if (marker !== 0xffe1 || view.getUint32(segment + 4) !== 0x45786966 || view.getUint16(segment + 8) !== 0) { segment = end; continue }
      const base = segment + 10
      const endian = view.getUint16(base)
      if (endian !== 0x4949 && endian !== 0x4d4d) return null
      const little = endian === 0x4949
      const inside = (offset: number, length: number) => { if (offset < base || offset + length > end) throw new Error('Invalid EXIF offset') }
      const u16 = (offset: number) => { inside(offset, 2); return view.getUint16(offset, little) }
      const u32 = (offset: number) => { inside(offset, 4); return view.getUint32(offset, little) }
      if (u16(base + 2) !== 42) return null
      const directory = (offset: number) => {
        const count = u16(offset)
        inside(offset + 2, count * 12 + 4)
        return Array.from({ length: count }, (_, i) => offset + 2 + i * 12)
      }
      const gpsTag = directory(base + u32(base + 4)).find(entry => u16(entry) === 0x8825)
      if (!gpsTag || u16(gpsTag + 2) !== 4 || u32(gpsTag + 4) !== 1) return null
      const gps = directory(base + u32(gpsTag + 8))
      const coordinate = (tag: number, negative: string) => {
        const entry = gps.find(e => u16(e) === tag)
        const reference = gps.find(e => u16(e) === tag - 1)
        if (!entry || !reference || u16(entry + 2) !== 5 || u32(entry + 4) !== 3 || u16(reference + 2) !== 2 || u32(reference + 4) !== 2) throw new Error('Missing GPS coordinate')
        const at = base + u32(entry + 8)
        const parts = [0, 8, 16].map(delta => u32(at + delta) / u32(at + delta + 4))
        if (!parts.every(Number.isFinite) || parts[1]! >= 60 || parts[2]! >= 60) throw new Error('Invalid GPS coordinate')
        const ref = String.fromCharCode(view.getUint8(reference + 8))
        if (!(tag === 2 ? ['N', 'S'] : ['E', 'W']).includes(ref)) throw new Error('Invalid GPS reference')
        return (parts[0]! + parts[1]! / 60 + parts[2]! / 3600) * (ref === negative ? -1 : 1)
      }
      const latitude = coordinate(2, 'S'), longitude = coordinate(4, 'W')
      return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null
    }
  } catch { /* Malformed metadata is not a valid GPS fix. */ }
  return null
}
