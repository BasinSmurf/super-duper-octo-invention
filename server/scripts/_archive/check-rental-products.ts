import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

async function main() {
  const sep = "=".repeat(100);

  // 1) Products with "rental" in name or partNumber
  console.log(sep);
  console.log("  QUERY 1: Products where name or partNumber contains rental");
  console.log(sep);

  const rentalProducts = await prisma.product.findMany({
    where: { OR: [{ name: { contains: "rental", mode: "insensitive" } }, { partNumber: { contains: "rental", mode: "insensitive" } }] },
    select: { partNumber: true, name: true, defaultSellPrice: true, defaultRentalRateDaily: true, defaultRentalRateWeekly: true, defaultRentalRateMonthly: true, unitOfMeasure: true, productType: true, category: true, qbItemType: true, qbItemFullName: true, isActive: true },
    orderBy: { partNumber: "asc" },
  });
  printProducts(rentalProducts);

  // 2) Service-type products with time/rental keywords
  console.log("\n" + sep);
  console.log("  QUERY 2: Service-type products (qbItemType=service) with time/rental keywords");
  console.log(sep);

  const keywords = ["tech", "hour", "day", "week", "month", "monitoring", "standby", "rental", "rent"];
  const serviceProducts = await prisma.product.findMany({
    where: { qbItemType: "service", OR: keywords.map((kw) => ({ name: { contains: kw, mode: "insensitive" as const } })) },
    select: { partNumber: true, name: true, defaultSellPrice: true, defaultRentalRateDaily: true, defaultRentalRateWeekly: true, defaultRentalRateMonthly: true, unitOfMeasure: true, productType: true, category: true, qbItemType: true, qbItemFullName: true, isActive: true },
    orderBy: { partNumber: "asc" },
  });
  printProducts(serviceProducts);

  // 3) Products with productType = rental or both
  console.log("\n" + sep);
  console.log("  QUERY 3: Products where productType = rental or both");
  console.log(sep);

  const rentalTypeProducts = await prisma.product.findMany({
    where: { productType: { in: ["rental", "both"] } },
    select: { partNumber: true, name: true, defaultSellPrice: true, defaultRentalRateDaily: true, defaultRentalRateWeekly: true, defaultRentalRateMonthly: true, unitOfMeasure: true, productType: true, category: true, qbItemType: true, qbItemFullName: true, isActive: true },
    orderBy: { partNumber: "asc" },
  });
  printProducts(rentalTypeProducts);

  // 4) Products with any rental rate set
  console.log("\n" + sep);
  console.log("  QUERY 4: Products with any rental rate (daily/weekly/monthly) set");
  console.log(sep);

  const ratedProducts = await prisma.product.findMany({
    where: { OR: [{ defaultRentalRateDaily: { not: null } }, { defaultRentalRateWeekly: { not: null } }, { defaultRentalRateMonthly: { not: null } }] },
    select: { partNumber: true, name: true, defaultSellPrice: true, defaultRentalRateDaily: true, defaultRentalRateWeekly: true, defaultRentalRateMonthly: true, unitOfMeasure: true, productType: true, category: true, qbItemType: true, qbItemFullName: true, isActive: true },
    orderBy: { partNumber: "asc" },
  });
  printProducts(ratedProducts);

  // 5) Search the QB items CSV
  console.log("\n" + sep);
  console.log("  CSV SEARCH: Lines from itemList.CSV containing rental or rent");
  console.log(sep);

  const csvPath = "C:/turdhurdles/itemList.CSV";
  if (fs.existsSync(csvPath)) {
    const csvContent = fs.readFileSync(csvPath, "utf-8");
    const csvLines = csvContent.split(/\r\n?|\n/);
    const header = csvLines[0];
    console.log("  Header: " + header);
    const matches = csvLines.filter((line: string, i: number) => i > 0 && /rental|rent\b/i.test(line));
    console.log("  Found " + matches.length + " matching lines:\n");
    for (const line of matches) { console.log("  " + line); }
  } else { console.log("  CSV file not found at: " + csvPath); }

  // Summary
  console.log("\n" + sep);
  console.log("  SUMMARY");
  console.log(sep);
  const totalProducts = await prisma.product.count();
  const totalService = await prisma.product.count({ where: { qbItemType: "service" } });
  const totalRentalType = await prisma.product.count({ where: { productType: { in: ["rental", "both"] } } });
  console.log("  Total products in DB: " + totalProducts);
  console.log("  Products with qbItemType=service: " + totalService);
  console.log("  Products with productType=rental or both: " + totalRentalType);
  console.log("  Products with rental rates set: " + ratedProducts.length);
}

type ProdRow = { partNumber: string; name: string; defaultSellPrice: any; defaultRentalRateDaily: any; defaultRentalRateWeekly: any; defaultRentalRateMonthly: any; unitOfMeasure: string | null; productType: string; category: string; qbItemType: string | null; qbItemFullName: string | null; isActive: boolean; };

function printProducts(products: ProdRow[]) {
  if (products.length === 0) { console.log("  (no results)\n"); return; }
  console.log("  Found " + products.length + " products:\n");
  for (const p of products) {
    console.log("  " + p.partNumber.padEnd(20) + " | " + (p.name || "").padEnd(50) + " | sell=$" + (p.defaultSellPrice ?? "n/a") + " | daily=$" + (p.defaultRentalRateDaily ?? "n/a") + " weekly=$" + (p.defaultRentalRateWeekly ?? "n/a") + " monthly=$" + (p.defaultRentalRateMonthly ?? "n/a") + " | UoM=" + (p.unitOfMeasure ?? "n/a") + " | type=" + p.productType + " | cat=" + p.category + " | qbType=" + (p.qbItemType ?? "n/a") + " | qbName=" + (p.qbItemFullName ?? "n/a") + " | active=" + p.isActive);
  }
}

main()
  .catch((e) => { console.error("Error:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
