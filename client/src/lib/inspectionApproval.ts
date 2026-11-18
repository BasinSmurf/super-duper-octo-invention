interface Approval {
  customerApprovedName?: string | null
  customerApprovedSignature?: string | null
  customerApprovedAt?: string | null
}

/** Preserve the original approval time unless the approver or signature changes. */
export function inspectionApproval(name: string, signature: string | null, previous: Approval | null | undefined, now: string) {
  const customerApprovedName = name.trim() || null
  const changed = customerApprovedName !== (previous?.customerApprovedName ?? null)
    || signature !== (previous?.customerApprovedSignature ?? null)
  return {
    customerApprovedName,
    customerApprovedSignature: signature,
    customerApprovedAt: customerApprovedName || signature
      ? changed || !previous?.customerApprovedAt ? now : previous.customerApprovedAt
      : null,
  }
}
