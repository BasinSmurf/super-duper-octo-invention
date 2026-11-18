import { describe, expect, it } from 'vitest';
import { correctBomExtras } from './rentalComposition.js';

describe('correctBomExtras', () => {
  const monitors = { id: 'bomx-monitor_area', label: 'Area monitor (over baseline)', qty: 2, rate: null };
  const scba = { id: 'bomx-supplied_air_component', label: 'SCBA (over baseline)', qty: 1, rate: null };

  it('prices, recounts, or drops the extras the office was looking at', () => {
    const out = correctBomExtras({ bomExtras: [monitors, scba] }, [{ key: 'bomx-monitor_area', rate: 75, qty: 3 }]);
    expect(out.bomExtras).toEqual([{ ...monitors, rate: 75, qty: 3 }]);
  });

  it('leaves an earlier package window\'s extras alone when they are outside the corrected set', () => {
    // Before an on-job switch the monitors were overages; the current package
    // covers them, so the office only ever saw (and corrected) the SCBA.
    const earlier = { bomExtras: [monitors, scba] };
    const out = correctBomExtras(earlier, [{ key: 'bomx-supplied_air_component', rate: 35, qty: 1 }], new Set(['bomx-supplied_air_component']));
    expect(out.bomExtras).toEqual([monitors, { ...scba, rate: 35 }]);
  });
});
