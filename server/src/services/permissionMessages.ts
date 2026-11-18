const ROLE_LABELS: Record<string, string> = {
  field_tech: 'Field Tech', dispatch: 'Dispatch', field_super: 'Field Supervisor',
  billing_ar: 'Billing / AR', ar_supervisor: 'AR Supervisor', trainer: 'Trainer', train_admin: 'Training Admin',
  boss: 'Boss', platform_admin: 'Platform Admin', customer: 'Customer',
};

export function permissionDeniedMessage(action: string, roles: readonly string[]): string {
  const labels = [...new Set(roles)].map(role => ROLE_LABELS[role] ?? role);
  const allowed = labels.length < 3
    ? labels.join(' or ')
    : `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)}`;
  return `Cannot ${action.charAt(0).toLowerCase() + action.slice(1)} due to permissions. ${allowed
    ? `Must be ${allowed} to continue.`
    : 'No roles currently have access. Contact a Platform Admin.'}`;
}
