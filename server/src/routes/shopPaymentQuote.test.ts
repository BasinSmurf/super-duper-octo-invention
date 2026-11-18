import { beforeEach, describe, expect, it, vi } from 'vitest';
const prisma=vi.hoisted(()=>({shopWorkOrder:{findUnique:vi.fn()},product:{findMany:vi.fn()},priceLevel:{findMany:vi.fn()}}));
vi.mock('../db.js', async importOriginal => ({ ...await importOriginal<typeof import('../db.js')>(), ...(()=>({prisma}))() }));
vi.mock('../utils/servicePartMap.js',()=>({getLaborProduct:vi.fn().mockResolvedValue(null),getMileageProduct:vi.fn().mockResolvedValue(null)}));
import { shopOrdersRouter } from './shopOrders.js';
const item={id:'i',status:'shop_complete',serialNumber:'SYNTHETIC-1',equipmentCategory:'personal_monitor',serviceType:'calibrate',isWarranty:false,parentItemId:null,
  hardClosesAt:new Date(Date.now()+48*3600000),billing:{services:[{productId:'cal',partNumber:'0631001',name:'Calibration',quantity:1,rate:35}]}};
beforeEach(()=>{vi.clearAllMocks();prisma.product.findMany.mockResolvedValue([{id:'cal',qbItemListId:'qb-cal',qbItemFullName:'0631001'}]);prisma.priceLevel.findMany.mockResolvedValue([]);});
async function quote(items:any[]) {
  prisma.shopWorkOrder.findUnique.mockResolvedValue({id:'wo',workOrderNumber:'SW-TEST',companyId:'c',company:{name:'SYNTHETIC',taxExempt:true,qbPriceLevelId:null},tier1:false,billingExtras:null,items,payments:[],paidAtDropVia:null});
  const json=vi.fn(),next=vi.fn();
  const route=shopOrdersRouter.stack.find(l=>l.route?.path==='/:id/billing-route')!.route;
  await route.stack[0].handle({params:{id:'wo'}},{json},next);
  expect(next).not.toHaveBeenCalled();return json.mock.calls[0][0];
}
describe('counter quote before hard close',()=>{
  it('includes saved calibration charges during the 48-hour correction window',async()=>{
    expect(await quote([item])).toMatchObject({total:35,amountDue:35,unitsPending:1,route:'standard'});
  });
  it('also includes in-progress work but excludes warranty units and assembly children',async()=>{
    expect(await quote([{...item,status:'in_work'},{...item,id:'w',isWarranty:true},{...item,id:'child',parentItemId:'i'}])).toMatchObject({total:35,unitsPending:1});
  });
});
