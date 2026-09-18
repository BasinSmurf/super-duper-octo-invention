import { buildSalesOrderAdd } from '../src/services/qbxmlBuilder.js';

const xml = buildSalesOrderAdd({
  customerFullName: 'Baker Hughes I',
  txnDate: new Date('2026-02-22'),
  refNumber: 'INV-2026-00002',
  poNumber: null,
  memo: 'Sundog INV-2026-00002',
  lines: [{
    qbItemFullName: '11009',
    description: 'Fit Test — jon smith',
    quantity: 1,
    rate: '35.00',
    amount: '35.00',
  }],
});

console.log(xml);
