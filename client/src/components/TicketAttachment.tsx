import { useEffect, useState } from 'react'

export function TicketAttachment({ attachment }: { attachment: { id: string; fileName: string; filePath: string | null; mimeType: string | null } }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    setUrl(null); setError('')
    if (attachment.filePath?.startsWith('data:image/')) { setUrl(attachment.filePath); return }
    const token = localStorage.getItem('sundog_token')
    fetch(`/api/attachments/${encodeURIComponent(attachment.id)}/content`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('Attachment unavailable'); return response.blob() })
      .then(blob => { if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl) } })
      .catch(err => { if (!controller.signal.aborted) setError(err.message) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [attachment.id, attachment.filePath])
  if (error) return <span className="p-2 text-center text-red-700">{attachment.fileName}: {error}</span>
  if (!url) return <span className="p-2">Loading {attachment.fileName}…</span>
  const safePreview = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'].includes(attachment.mimeType || '') || url.startsWith('data:image/')
  return <a href={url} download={safePreview ? undefined : attachment.fileName} target="_blank" rel="noopener noreferrer" className="flex h-full w-full items-center justify-center" title={attachment.fileName}>
    {(attachment.mimeType?.startsWith('image/') && !attachment.mimeType.includes('svg')) || url.startsWith('data:image/')
      ? <img src={url} alt={attachment.fileName} className="h-full w-full object-cover" /> : <span className="p-2 text-blue-700 underline">{attachment.fileName}</span>}
  </a>
}
