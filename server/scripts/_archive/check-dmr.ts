import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const total = await prisma.dmrReferenceWell.count()
  console.log('Total DMR reference wells:', total)

  const matched = await prisma.dmrReferenceWell.count({ where: { matchedWellId: { not: null } } })
  console.log('Already matched to active wells:', matched)

  if (total > 0) {
    const sample = await prisma.dmrReferenceWell.findFirst({
      select: {
        wellName: true,
        apiNumber: true,
        operatorName: true,
        fieldName: true,
        county: true,
        latitude: true,
        longitude: true,
        wellType: true,
        wellStatus: true,
        section: true,
        township: true,
        range: true,
      },
    })
    console.log('Sample record:', JSON.stringify(sample, null, 2))

    // Count by operator (top 10)
    const byOperator = await prisma.dmrReferenceWell.groupBy({
      by: ['operatorName'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    })
    console.log('\nTop 10 operators:')
    byOperator.forEach(o => console.log(`  ${o._count.id} wells - ${o.operatorName}`))
  }
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1) })
