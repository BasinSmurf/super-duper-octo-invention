import { describe, it, expect, vi } from 'vitest';
import { assertShopBinsAvailable } from './shopBins.js';

const item = (bin: string) => ({ equipmentCategory: 'personal_monitor', customData: { binLocation: bin } });
function harness(rows: any[] = []) {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue([]),
    shopWorkOrderItem: { findMany: vi.fn().mockImplementation(({ where }) => rows.filter(row =>
      !['returned', 'condemned'].includes(row.status) && row.workOrderId !== where.workOrderId?.not)) },
  };
}
describe('job-owned shop bins', () => {
  it('allows multiple new items in the same bin and locks it once', async () => {
    const tx = harness();
    await assertShopBinsAvailable(tx as any, [item('Bin 13'), item('Bin 13')]);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });
  it('allows additions and edits into a bin held by the same job', async () => {
    const tx = harness([{ ...item('Bin 13'), workOrderId: 'own', status: 'in_work' }]);
    await expect(assertShopBinsAvailable(tx as any, [item('Bin 13')], 'own')).resolves.toBeUndefined();
  });
  it('rejects another active job even if one row belongs to this job', async () => {
    const tx = harness([
      { ...item('Bin 13'), workOrderId: 'own', status: 'in_work' },
      { ...item('Bin 13'), workOrderId: 'other', status: 'received', workOrder: { workOrderNumber: 'SW-OTHER' } },
    ]);
    await expect(assertShopBinsAvailable(tx as any, [item('Bin 13')], 'own')).rejects.toThrow('SW-OTHER');
  });
  it('allows released bins and separate available bins', async () => {
    const tx = harness([{ ...item('Bin 13'), workOrderId: 'old', status: 'returned' }]);
    await assertShopBinsAvailable(tx as any, [item('Bin 14'), item('Bin 13')]);
    expect(tx.$executeRawUnsafe.mock.calls.map(c => c[1])).toEqual(['shop-bin:Bin 13', 'shop-bin:Bin 14']);
  });
  it('takes the bin lock before inspecting occupancy', async () => {
    const tx = harness();
    await assertShopBinsAvailable(tx as any, [item('Bin 13')]);
    expect(tx.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(tx.shopWorkOrderItem.findMany.mock.invocationCallOrder[0]);
  });
  it('does not query bins when none are assigned', async () => {
    const tx = harness();
    await assertShopBinsAvailable(tx as any, [item('')]);
    expect(tx.shopWorkOrderItem.findMany).not.toHaveBeenCalled();
  });
});
