/**
 * Create / update a customer-portal account.
 *
 * Portal accounts have role = customer and are scoped to a single Company.
 * They can only sign in with email + password and only ever see that
 * company's service history via /api/portal.
 *
 * Usage:
 *   npx tsx scripts/create-portal-user.ts \
 *     --email buyer@acme.com \
 *     --company "Continental Resources, Inc" \
 *     --name "Jane Buyer" \
 *     --password "set-a-strong-one"
 *
 * Flags:
 *   --company   Company name (case-insensitive) or id. Required.
 *   --email     Login email. Required.
 *   --name      Display name. Defaults to the email local-part.
 *   --password  Initial password. Required for new accounts; on an existing
 *               portal account it resets the password.
 *
 * Re-running for an existing portal account updates its company / password.
 * The script refuses to convert an existing INTERNAL staff account into a
 * portal account — make a separate login for the customer instead.
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/db.js';


function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const companyRef = arg('company')?.trim();
  const password = arg('password');
  const name = arg('name')?.trim();

  if (!email || !companyRef) {
    console.error('Error: --email and --company are required.');
    process.exit(1);
  }

  // Resolve the company by id first, then by case-insensitive name.
  let company = await prisma.company.findUnique({ where: { id: companyRef } });
  if (!company) {
    const matches = await prisma.company.findMany({
      where: { name: { equals: companyRef, mode: 'insensitive' } },
    });
    if (matches.length === 1) {
      company = matches[0];
    } else if (matches.length > 1) {
      console.error(`Error: "${companyRef}" matches ${matches.length} companies. Pass the company id instead:`);
      matches.forEach((c) => console.error(`  ${c.id}  ${c.name}`));
      process.exit(1);
    }
  }
  if (!company) {
    console.error(`Error: no company found for "${companyRef}".`);
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing && existing.role !== 'customer') {
    console.error(
      `Error: ${email} already exists as an internal account (role: ${existing.role}). ` +
      `Refusing to convert it. Use a different email for the customer portal login.`,
    );
    process.exit(1);
  }

  const passwordHash = password ? await bcrypt.hash(password, 10) : undefined;

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        companyId: company.id,
        isActive: true,
        ...(name ? { name } : {}),
        ...(passwordHash ? { passwordHash } : {}),
      },
    });
    console.log(`Updated portal account ${email} → ${company.name}`);
    if (passwordHash) console.log('Password reset.');
  } else {
    if (!passwordHash) {
      console.error('Error: --password is required to create a new account.');
      process.exit(1);
    }
    await prisma.user.create({
      data: {
        email,
        name: name || email.split('@')[0],
        role: 'customer',
        companyId: company.id,
        passwordHash,
        isActive: true,
      },
    });
    console.log(`Created portal account ${email} → ${company.name}`);
  }

  console.log('The customer can now sign in at /login using the "Password" tab.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
