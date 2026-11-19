import { describe, expect, it } from 'vitest';
import { canTransitionShopItem, getAvailableShopItemTransitions } from './shopStateMachine.js';

describe('condemned is a final disposition from every active shop state', () => {
  it.each([
    'received', 'diagnosing', 'awaiting_parts', 'awaiting_approval', 'in_work',
    'warranty_out', 'outside_service', 'qc_testing', 'on_hold', 'shop_complete',
  ] as const)('allows condemnation from %s', status => {
    expect(canTransitionShopItem(status, 'condemned')).toBe(true);
  });

  it('does not allow condemned equipment to resume work or require a return transition', () => {
    expect(getAvailableShopItemTransitions('condemned')).toEqual([]);
    expect(canTransitionShopItem('returned', 'condemned')).toBe(false);
  });
});
