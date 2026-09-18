/**
 * Course → QuickBooks Product Mapping
 *
 * The ClassPRO course catalog (cp_courses.qbPartNumber) is consulted first —
 * it accepts either the slug or the display label, which matters because
 * roster records store the *label* ("H2S CLEAR") and the static map below
 * keys on the slug ("h2s_clear"), so label-keyed lookups used to fall
 * through to Misc. The static maps remain as the bad-divorce fallback.
 * Actual prices come from the Product table (imported from QB CSV).
 */

import { prisma } from '../index.js';
import { findCourse } from '../services/courseCatalog.js';

// Static fallback map: courseType slug → QB part number
const COURSE_TO_PART: Record<string, string> = {
  h2s_clear:                '11003',
  pec_safeland:             '11005',
  first_aid_cpr:            '11011',
  safety_meeting:           '10012',
  man_down_rescue:          '11059',
  fex_safety_1hr:           '11016',
  h2s_pec_combo:            '11007',
  h2s_awareness_1hr:        '11001',
  confined_space_4hr:       '11013',
  defensive_driving_4hr:    '11015',
  bloodborne_pathogens_1hr: 'Misc',
  other:                    'Misc',
};

// Fallback prices if product not found in DB (should rarely happen after CSV import)
const FALLBACK_PRICES: Record<string, number> = {
  h2s_clear:                175,
  pec_safeland:             199,
  first_aid_cpr:            125,
  safety_meeting:           0,
  man_down_rescue:          200,
  fex_safety_1hr:           150,
  h2s_pec_combo:            250,
  h2s_awareness_1hr:        125,
  confined_space_4hr:       500,
  defensive_driving_4hr:    200,
  bloodborne_pathogens_1hr: 100,
  other:                    0,
};

export interface CourseProductInfo {
  productId: string | null;
  partNumber: string;
  name: string;
  price: number;
  qbItemFullName: string | null;
  qbItemListId: string | null;
}

/**
 * Look up the Product for a given course type.
 * Returns product info with pricing from the DB, falling back to hardcoded defaults.
 */
export async function getProductForCourse(courseType: string): Promise<CourseProductInfo> {
  const course = await findCourse(courseType);
  const partNumber = course?.qbPartNumber || COURSE_TO_PART[courseType] || 'Misc';

  // Try to find in DB
  const product = await prisma.product.findFirst({
    where: { partNumber },
    select: {
      id: true,
      partNumber: true,
      name: true,
      defaultSellPrice: true,
      qbItemFullName: true,
      qbItemListId: true,
    },
  });

  if (product) {
    const price = product.defaultSellPrice
      ? parseFloat(product.defaultSellPrice.toString())
      : (FALLBACK_PRICES[courseType] ?? 0);

    return {
      productId: product.id,
      partNumber: product.partNumber,
      name: product.name,
      price,
      qbItemFullName: product.qbItemFullName,
      qbItemListId: product.qbItemListId,
    };
  }

  // Product not in DB — return fallback
  return {
    productId: null,
    partNumber,
    name: course?.name ?? courseType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    price: FALLBACK_PRICES[courseType] ?? 0,
    qbItemFullName: null,
    qbItemListId: null,
  };
}

/**
 * Human-readable course label.
 * Matches the labels from TrainingClassEditor.COURSE_TYPES.
 */
const COURSE_LABELS: Record<string, string> = {
  h2s_clear:                'H2S CLEAR',
  pec_safeland:             'PEC SafeLand',
  first_aid_cpr:            'First Aid/CPR',
  safety_meeting:           'Safety Meeting',
  man_down_rescue:          'Man Down Rescue',
  fex_safety_1hr:           'FEX Safety (1 hr)',
  h2s_pec_combo:            'H2S Awareness + PEC Basic (1hr + 8hr)',
  h2s_awareness_1hr:        'H2S Awareness (1 hr)',
  confined_space_4hr:       'Confined Space (4 hr)',
  defensive_driving_4hr:    'Defensive Driving (4 hr)',
  bloodborne_pathogens_1hr: 'Bloodborne Pathogens (1 hr)',
  other:                    'Other',
};

export function getCourseLabel(courseType: string): string {
  return COURSE_LABELS[courseType] || courseType;
}
