import { describe, it, expect, vi } from 'vitest';
import { checkCondemnEvidence, assertCondemnEvidence } from './condemnEvidence.js';

/**
 * A stand-in for the two Prisma models this guard touches. Deliberately hand-
 * rolled rather than a full mock library: the thing under test is a decision,
 * and the interesting part is WHICH attachments it decides to count.
 */
function fakePrisma(opts: {
  item?: { id: string; parentItemId: string | null } | null;
  attachmentCount?: number;
}) {
  const countSpy = vi.fn().mockResolvedValue(opts.attachmentCount ?? 0);
  return {
    prisma: {
      shopWorkOrderItem: {
        findUnique: vi.fn().mockResolvedValue(
          opts.item === undefined ? { id: 'unit-1', parentItemId: null } : opts.item,
        ),
      },
      attachment: { count: countSpy },
    } as never,
    countSpy,
  };
}

describe('checkCondemnEvidence', () => {
  it('blocks a condemn on a unit with no attachments', async () => {
    const { prisma } = fakePrisma({ attachmentCount: 0 });
    const result = await checkCondemnEvidence(prisma, 'unit-1');
    expect(result.satisfied).toBe(false);
    expect(result.message).toMatch(/cannot be condemned without evidence/i);
  });

  it('allows a condemn once the unit has any attachment', async () => {
    const { prisma } = fakePrisma({ attachmentCount: 1 });
    const result = await checkCondemnEvidence(prisma, 'unit-1');
    expect(result.satisfied).toBe(true);
    expect(result.attachmentCount).toBe(1);
  });

  it('counts attachments made on the unit OR on one of its inspections', async () => {
    // A tech who photographed the fault inside the inspection editor has already
    // done the thing being asked for. Sending them elsewhere to do it again
    // would teach them the gate is noise.
    const { prisma, countSpy } = fakePrisma({ attachmentCount: 1 });
    await checkCondemnEvidence(prisma, 'unit-1');
    expect(countSpy).toHaveBeenCalledWith({
      where: { OR: [{ shopItemId: 'unit-1' }, { inspection: { shopItemId: 'unit-1' } }] },
    });
  });

  it('does not gate a sub-component — it rides with its parent assembly', async () => {
    // Matches how the QA gate already treats children: an SCBA regulator is not
    // separately condemned, it goes wherever the pack goes.
    const { prisma, countSpy } = fakePrisma({
      item: { id: 'child-1', parentItemId: 'unit-1' },
      attachmentCount: 0,
    });
    const result = await checkCondemnEvidence(prisma, 'child-1');
    expect(result.satisfied).toBe(true);
    expect(countSpy).not.toHaveBeenCalled();
  });

  it('does not block on an item that no longer exists', async () => {
    // Not this guard's job to invent a 404 — the caller's own lookup handles it.
    const { prisma } = fakePrisma({ item: null });
    const result = await checkCondemnEvidence(prisma, 'gone');
    expect(result.satisfied).toBe(true);
  });
});

describe('assertCondemnEvidence', () => {
  it('throws a recognisable error when evidence is missing', async () => {
    const { prisma } = fakePrisma({ attachmentCount: 0 });
    await expect(assertCondemnEvidence(prisma, 'unit-1')).rejects.toThrow(
      /cannot be condemned without evidence/i,
    );
    await expect(assertCondemnEvidence(prisma, 'unit-1')).rejects.toMatchObject({
      name: 'CondemnEvidenceMissing',
    });
  });

  it('resolves quietly when evidence exists', async () => {
    const { prisma } = fakePrisma({ attachmentCount: 3 });
    await expect(assertCondemnEvidence(prisma, 'unit-1')).resolves.toBeUndefined();
  });
});
