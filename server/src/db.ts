// Load .env before constructing the adapter — Prisma 7 no longer auto-loads it
// the way `new PrismaClient()` did in v6, and standalone scripts import this
// module directly. Idempotent: a no-op in containers where env is already set.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });

// Re-export the generated client surface (Prisma namespace, enums, model types)
// so the rest of the app imports everything from one place instead of @prisma/client.
export * from './generated/prisma/client.js';
