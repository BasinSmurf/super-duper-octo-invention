/** API success does not imply price-book compliance. Preserve nonblocking notices. */
export function enverusWarnings(...sources: unknown[]): string[] {
  const messages = new Set<string>()
  for (let source of sources) {
    if (typeof source === 'string') {
      try { source = JSON.parse(source) } catch { continue }
    }
    if (!source || typeof source !== 'object') continue
    const body = (source as any).body || source as any
    for (const resource of body.confirmMessage?.resourceMessages || []) {
      for (const message of resource.processMessages || []) {
        if (message.messageTypeCode?.codeValue === 'warning' && message.developerMessage?.messageTxt)
          messages.add(message.developerMessage.messageTxt)
      }
    }
    const receipt = body.receipt || body.events?.[0]?.data?.output?.receipt || body
    let lineNotices = false
    for (const line of receipt.lineItems || []) {
      for (const alerts of Object.values(line.complianceAlerts || {}) as any[]) {
        for (const [severity, alert] of Object.entries(alerts) as [string, any][]) {
          if (severity === 'green') continue
          for (const text of alert.conditions || [alert.alertCondition]) {
            if (text) {
              messages.add(`Line ${line.lineItemNumber}${line.productServiceCode ? ` (${line.productServiceCode})` : ''}: ${text}`)
              lineNotices = true
            }
          }
        }
      }
    }
    if (!lineNotices) {
      for (const summary of Object.values(receipt.complianceSummary || {}) as any[]) {
        if (!summary || typeof summary !== 'object') continue
        for (const [severity, alert] of Object.entries(summary) as [string, any][]) {
          if (severity !== 'green' && alert?.message) messages.add(alert.message)
        }
      }
    }
  }
  return [...messages]
}
