import { prisma } from '../db.js';

export const DEFAULT_COMPANY_NAME = 'Basin Safety';

export async function getBranding() {
  const config = await prisma.brandingConfig.findUnique({ where: { id: 'singleton' } });
  return {
    companyName: config?.companyName ?? DEFAULT_COMPANY_NAME,
    logoKey: config?.logoKey ?? null,
    logoUrl: config?.logoKey ? `/api/branding/logo?v=${config.updatedAt.getTime()}` : '/servicepro-logo.png',
  };
}

export function publicBranding(config: Awaited<ReturnType<typeof getBranding>>) {
  return { companyName: config.companyName, logoUrl: config.logoUrl, hasCustomLogo: !!config.logoKey };
}
