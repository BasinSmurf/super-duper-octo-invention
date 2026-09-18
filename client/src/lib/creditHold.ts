/**
 * The one credit-hold message, shown verbatim everywhere the hold bites:
 * the ticket wizard's customer step and a shop work order waiting for pickup.
 * Mirrors CREDIT_HOLD_MESSAGE on the server (server/src/utils/companyGuards.ts)
 * so the banner and the 409 the API throws read identically — staff shouldn't
 * see two different wordings for the same block.
 */
export const CREDIT_HOLD_MESSAGE =
  'Customer on credit hold. Please contact Accounts Receivable to resolve.'
