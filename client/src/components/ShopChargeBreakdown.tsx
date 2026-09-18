export interface ShopCharge {
  lineNumber: number; description: string; partNumber: string | null;
  serialNumber: string | null; sourceShopItemId: string | null;
  chargeKind: string; quantity: number; unitOfMeasure: string; rate: number;
  amount: number; isTaxable: boolean; notes: string | null;
}
export interface ShopChargePreview {
  lines: ShopCharge[]; subtotal: number; taxableSubtotal: number;
  excluded: Array<{ serialNumber: string; reason: string }>;
  vendorCosts?: Array<{ serialNumber: string; invoiceNumber: string | null; cost: number; partNumber: string | null }>;
}
const money = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export function ShopChargeBreakdown({ preview, error }: { preview: ShopChargePreview | null; error: string }) {
  return <section className="border border-slate-200 rounded-lg bg-white p-4 space-y-3 mb-4" aria-label="Charge breakdown">
    <h3 className="font-semibold text-slate-800">Charge breakdown — review before close / release</h3>
    <p className="text-xs text-slate-500">Saved charges, including work in progress. Parts are taxable unless the customer is exempt; labor and services are non-taxable. Save edits to refresh.</p>
    {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !preview ? <p className="text-sm text-slate-500">Loading charges…</p> : <>
      <div className="overflow-x-auto"><table className="w-full text-xs text-left">
        <thead><tr className="border-b text-slate-500">{['Type', 'Part / service', 'Used on S/N', 'Qty', 'Rate', 'Amount', 'Tax'].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead>
        <tbody>{preview.lines.map(l => <tr key={l.lineNumber} className="border-b border-slate-100">
          <td className="p-2 capitalize">{l.chargeKind}</td>
          <td className="p-2"><div className="font-medium">{l.partNumber || '—'}</div>{l.description}{l.notes && <div className="text-slate-500">{l.notes}</div>}</td>
          <td className="p-2 font-mono">{l.serialNumber || (l.sourceShopItemId ? 'Not recorded' : 'Order / see description')}</td>
          <td className="p-2 whitespace-nowrap">{l.quantity} {l.unitOfMeasure}</td><td className="p-2">{money(l.rate)}</td><td className="p-2 font-medium">{money(l.amount)}</td><td className="p-2">{l.isTaxable ? 'Taxable' : 'Non-taxable'}</td>
        </tr>)}</tbody>
      </table></div>
      {preview.excluded.map((i, n) => <p key={n} className="text-xs text-slate-500">S/N {i.serialNumber}: excluded — {i.reason.replace(/_/g, ' ')}</p>)}
      {preview.vendorCosts?.map((v, n) => <p key={`vendor-${n}`} className="text-xs text-slate-500">Internal vendor cost — S/N {v.serialNumber}{v.invoiceNumber ? `, invoice ${v.invoiceNumber}` : ''}: {money(v.cost)}. Customer charge is included under {v.partNumber}; this cost is not added to the total.</p>)}
      <div className="flex flex-wrap justify-end gap-5 text-sm"><span>Taxable parts: <b>{money(preview.taxableSubtotal)}</b></span><span>Non-taxable: <b>{money(preview.subtotal - preview.taxableSubtotal)}</b></span><span>Subtotal: <b>{money(preview.subtotal)}</b></span></div>
    </>}
  </section>;
}
