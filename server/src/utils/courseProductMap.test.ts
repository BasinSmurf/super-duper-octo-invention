import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ product: { findFirst: vi.fn() }, findCourse: vi.fn() }));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(() => ({ prisma: { product: mocks.product } }))() }));
vi.mock('../services/courseCatalog.js', () => ({ findCourse: mocks.findCourse }));
import { getProductForCourse, trainingBillingBasis } from './courseProductMap.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.findCourse.mockResolvedValue({ name: 'Safety Meeting', qbPartNumber: '10012' });
  mocks.product.findFirst.mockResolvedValue({ id: 'product', partNumber: '10012', name: 'Safety Meeting', defaultSellPrice: null });
});

describe('training course invoice pricing', () => {
  it('identifies Safety Meeting as per-class under either the stored label or course code', () => {
    expect(trainingBillingBasis('Safety Meeting')).toBe('per_class');
    expect(trainingBillingBasis('safety_meeting')).toBe('per_class');
    expect(trainingBillingBasis('H2S CLEAR')).toBe('per_student');
  });
  it.each(['Safety Meeting', 'safety_meeting'])('does not turn a missing price into a free class (%s)', async name => {
    await expect(getProductForCourse(name)).rejects.toThrow(/price.*configured|configure.*price/i);
  });
  it('does not invent a fallback price when the billing product is missing', async () => {
    mocks.product.findFirst.mockResolvedValue(null);
    await expect(getProductForCourse('first_aid_cpr')).rejects.toThrow(/product/i);
  });
  it('does not silently map an unknown class to Misc', async () => {
    mocks.findCourse.mockResolvedValue(null);
    mocks.product.findFirst.mockResolvedValue({ id: 'misc', partNumber: 'Misc', defaultSellPrice: 0 });
    await expect(getProductForCourse('Unmapped synthetic course')).rejects.toThrow(/billing product|mapping/i);
  });
  it.each([-1, 'NaN'])('rejects invalid configured prices (%s)', async price => {
    mocks.product.findFirst.mockResolvedValue({ id: 'product', partNumber: '10012', defaultSellPrice: price });
    await expect(getProductForCourse('Safety Meeting')).rejects.toThrow(/price/i);
  });
  it.each([0, '0.00', '125.50'])('honors an explicit configured price including zero (%s)', async price => {
    mocks.product.findFirst.mockResolvedValue({ id: 'product', partNumber: '10012', defaultSellPrice: price });
    expect((await getProductForCourse('Safety Meeting')).price).toBe(Number(price));
  });
});
