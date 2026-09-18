/**
 * bluelion-inspect-payloads.ts — print the exact BlueLion records the queue
 * processor would submit, without sending anything. Run with:
 *   npx tsx scripts/bluelion-inspect-payloads.ts
 */
import { prisma } from '../src/db.js';
import { buildAssetRecord, buildServiceRecord, buildRecord } from '../src/services/blueLionQueueProcessor.js';

async function main(): Promise<void> {
  const asset = await prisma.blueLionSyncQueue.findFirst({ where: { entityType: 'asset' } });
  if (asset) {
    console.log('ASSET →', JSON.stringify(await buildAssetRecord(asset.entityId, asset.externalId), null, 2));
  } else console.log('no asset queue rows');

  const svc = await prisma.blueLionSyncQueue.findFirst({ where: { entityType: 'equipment_inspection' } });
  if (svc) {
    console.log('SERVICE →', JSON.stringify(await buildServiceRecord(svc.entityId, svc.externalId), null, 2));
  } else console.log('no service queue rows');

  const ft = await prisma.fitTestRecord.findFirst({
    where: { includesFitTest: true },
    orderBy: { testDate: 'desc' },
  });
  if (ft) {
    console.log(
      'FIT-TEST TRAINING →',
      JSON.stringify(await buildRecord({ entityType: 'fit_test', entityId: ft.id, externalId: `sp-ft-${ft.id}` }), null, 2),
    );
  } else console.log('no fit test records');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
