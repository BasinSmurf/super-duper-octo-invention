/**
 * courseCatalog.ts — ClassPRO course-catalog resolution.
 *
 * The cp_courses table is the source of truth for course definitions.
 * Historical data is messy: roster records store the display *label*
 * ("H2S CLEAR") while some legacy code keys on the slug ("h2s_clear"),
 * so resolution accepts either — exact code match first, then a
 * case-insensitive name match.
 *
 * Every consumer keeps its legacy static map as a bad-divorce fallback
 * for courses missing from the catalog (free-text "Other" courses, or a
 * catalog row someone deleted). A DB error degrades to the fallback too.
 * Invoice generation separately requires a mapped product and an explicit
 * configured price; availability fallbacks must not invent billing amounts.
 */

import { prisma } from '../db.js';
import { mapCourseToClassCode } from './blueLionClassMap.js';

export interface CatalogCourse {
  id: string;
  code: string;
  name: string;
  durationHours: number | null;
  validityMonths: number | null;
  passingScore: number | null;
  vaultProClassCode: string | null;
  cardsOnSite: boolean;
  qbPartNumber: string | null;
  bookVersion: string | null;
  testVersion: string | null;
  standard: string | null;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Find a catalog course by slug or display label. Inactive courses still
 * resolve — old roster records keep pointing at the course they were
 * trained under after it's retired from the picker.
 */
export async function findCourse(codeOrName: string | null | undefined): Promise<CatalogCourse | null> {
  if (!codeOrName?.trim()) return null;
  const q = codeOrName.trim();
  try {
    const byCode = await prisma.cpCourse.findUnique({ where: { code: q } });
    if (byCode) return byCode;
    return await prisma.cpCourse.findFirst({
      where: { name: { equals: q, mode: 'insensitive' } },
    });
  } catch (err) {
    console.error('[courseCatalog] lookup failed, falling back to static maps:', (err as Error).message);
    return null;
  }
}

/**
 * VaultPRO (BlueLion) cert-type classCode for a course — catalog first,
 * then the static blueLionClassMap table. null = unmapped; callers park
 * the record (needs_attention) rather than guessing a code.
 */
export async function resolveClassCode(courseName: string | null | undefined): Promise<string | null> {
  const course = await findCourse(courseName);
  if (course?.vaultProClassCode) return course.vaultProClassCode;
  return mapCourseToClassCode(courseName);
}
