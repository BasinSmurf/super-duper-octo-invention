export function SharedBinConfirmation({ bin, onConfirm, onCancel }: {
  bin: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="shared-bin-title" className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h2 id="shared-bin-title" className="text-lg font-semibold">Share {bin}?</h2>
        <p className="my-3 text-sm text-slate-600">Did you mean to put multiple items from this job in {bin}? A bin can hold multiple items from one job.</p>
        <div className="flex justify-end gap-3">
          <button type="button" autoFocus onClick={onCancel} className="rounded border px-3 py-2">Choose another bin</button>
          <button type="button" onClick={onConfirm} className="rounded bg-blue-800 px-3 py-2 text-white">Yes, share this bin</button>
        </div>
      </div>
    </div>
  )
}
