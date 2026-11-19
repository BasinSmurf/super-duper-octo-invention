/** Fetch through the authenticated API; the server resolves B2/buffer custody. */
export async function openStoredAttachment(id: string, fileName: string): Promise<void> {
  const token = localStorage.getItem('sundog_token')
  const response = await fetch(`/api/attachments/${encodeURIComponent(id)}/content`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) throw new Error('Could not open this attachment. Please retry.')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
