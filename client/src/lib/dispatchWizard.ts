/** Dispatch uses the same setup screens, ending before field records/results. */
export function dispatchWizardSteps(steps: string[]): string[] {
  return [...steps.filter(step => ['d3_services', 'who_where', 'af_customer', 'ft_setup', 'ih_setup', 'tr_setup'].includes(step)), 'dispatch_review']
}

/**
 * Which step a saved wizard draft reopens on.
 *
 * A dispatched ticket always opens on the FIRST screen (customer + site) until
 * the technician has saved it themselves: dispatch picks the customer and site
 * from the office, and a mismatched pair needs the site-sign photo that only
 * that screen captures. Tickets dispatched before this rule stored a later
 * step, so the stored step is ignored rather than trusted.
 */
export function wizardResumeStep(customData: { dispatchPrepared?: boolean; wizardDraft?: { step?: number; techSaved?: boolean } } | null | undefined): number {
  const saved = customData?.wizardDraft
  if (customData?.dispatchPrepared && !saved?.techSaved) return 1
  return saved?.step || 1
}
