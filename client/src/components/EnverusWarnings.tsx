import { enverusWarnings } from '@/lib/enverusWarnings'

export function EnverusWarnings({ sources }: { sources: unknown[] }) {
  const messages = enverusWarnings(...sources)
  if (!messages.length) return null
  return <div className="my-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900" role="status">
    <p className="font-medium">Enverus warnings / compliance alerts</p>
    <ul className="list-disc pl-4">{messages.map(message => <li key={message}>{message}</li>)}</ul>
  </div>
}
