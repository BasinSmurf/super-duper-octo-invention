import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const pad = await p.pad.findUnique({
    where: { id: '031b6ed5-acfa-43f1-a722-6febdc92a25b' },
    select: { id: true, name: true, isActive: true, customData: true },
  });
  console.log('Pad:', JSON.stringify(pad, null, 2));

  // Check any work points at this pad (including inactive)
  const wps = await p.workPoint.findMany({
    where: { padId: '031b6ed5-acfa-43f1-a722-6febdc92a25b' },
  });
  console.log('Work points at pad (any status): ' + wps.length);
  for (const wp of wps) {
    console.log('  ' + wp.id + ' | ' + wp.name + ' | active=' + wp.isActive);
  }

  await p.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
