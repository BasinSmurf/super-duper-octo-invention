import { describe, it, expect } from 'vitest';
import { newQbSessionDetails, recordQbSessionOutcome, formatQbSessionSummary } from './qbSessionSummary.js';
const start = new Date('2026-10-15T12:00:00Z');
const base = () => ({ processedItems: 0, successfulItems: 0, failedItems: 0, invoiceAdds: 0, createdAt: start, companyFile: 'C:\\QB\\Production.qbw', details: newQbSessionDetails() });
describe('QBWC last result details', () => {
  it('explains catalog work and existing invoice checks without claiming new invoices', () => {
    const s = base(); s.processedItems = 16; s.successfulItems = 16;
    recordQbSessionOutcome(s.details, {entityType:'item',action:'query',entityId:'catalog'}, 'success');
    s.details.catalogPages = 40; s.details.catalogItems = 1932;
    for (let i=0;i<15;i++) recordQbSessionOutcome(s.details, {entityType:'invoice',action:'query',entityId:`inv${i}`}, 'success', null, null, `INV-${i}: matches; SP $10.00 / QB $10.00; lines 1 / 1`);
    const result = formatQbSessionSummary(s, new Date(start.getTime()+93000));
    expect(result).toContain('0 invoices created');
    expect(result).toContain('Invoice checks: 15');
    expect(result).toContain('Item catalog syncs: 1 (40 pages, 1932 items read)');
    expect(result).toContain('INV-14: matches');
    expect(result).toContain('Duration: 93 seconds');
    expect(result).toContain('QB company file: C:\\QB\\Production.qbw');
  });
  it('includes actual QB invoice references and specific errors/retry state', () => {
    const s = base(); s.processedItems=2; s.successfulItems=1; s.invoiceAdds=1; s.failedItems=1;
    const e={entityType:'invoice',action:'add',entityId:'inv1'};
    recordQbSessionOutcome(s.details,e,'success','2026-00111');
    recordQbSessionOutcome(s.details,{...e,entityId:'inv2'},'pending',null,'QB 3140: Invalid item reference');
    const result=formatQbSessionSummary(s,start);
    expect(result).toContain('QB invoice numbers created: 2026-00111');
    expect(result).toContain('QB 3140: Invalid item reference [queued for retry]');
  });
  it('keeps discrepancies visible despite a successful query', () => {
    const s=base();
    recordQbSessionOutcome(s.details,{entityType:'invoice',action:'query',entityId:'i'},'success',null,null,'INV-1: DIFFERENCE; SP $20.00 / QB $10.00; lines 1 / 1');
    expect(formatQbSessionSummary(s,start)).toContain('INV-1: DIFFERENCE');
  });
  it('bounds details and clearly reports omitted results', () => {
    const s=base(); s.invoiceAdds=25; s.successfulItems=25;
    for(let i=0;i<25;i++) recordQbSessionOutcome(s.details,{entityType:'invoice',action:'add',entityId:`i${i}`},'success',`${i}`);
    expect(formatQbSessionSummary(s,start)).toContain('showing 20 of 25');
    expect(s.details.invoicesCreated).toHaveLength(20);
  });
  it('handles no work and expired sessions explicitly', () => {
    expect(formatQbSessionSummary(base(),start)).toContain('No queued work was processed.');
    expect(formatQbSessionSummary()).toContain('Session expired or unknown');
  });
});
