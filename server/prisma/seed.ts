import { prisma } from '../src/db.js';
import bcrypt from 'bcryptjs';


async function main() {
  console.log('Seeding database...');

  // Create admin user
  const adminPassword = await bcrypt.hash('admin123', 10);
  const adminPin = await bcrypt.hash('1234', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@basinsafetyus.com' },
    update: {},
    create: {
      email: 'admin@basinsafetyus.com',
      name: 'Platform Admin',
      role: 'platform_admin',
      passwordHash: adminPassword,
      pinHash: adminPin,
    },
  });
  console.log(`  Admin user: ${admin.email}`);

  // Create sample tech user
  const techPin = await bcrypt.hash('5678', 10);
  const tech = await prisma.user.upsert({
    where: { email: 'tech@basinsafetyus.com' },
    update: {},
    create: {
      email: 'tech@basinsafetyus.com',
      name: 'Sample Field Tech',
      role: 'field_tech',
      passwordHash: await bcrypt.hash('tech123', 10),
      pinHash: techPin,
    },
  });
  console.log(`  Tech user: ${tech.email}`);

  // Create dispatch user
  const dispatch = await prisma.user.upsert({
    where: { email: 'dispatch@basinsafetyus.com' },
    update: {},
    create: {
      email: 'dispatch@basinsafetyus.com',
      name: 'Sample Dispatcher',
      role: 'dispatch',
      passwordHash: await bcrypt.hash('dispatch123', 10),
    },
  });
  console.log(`  Dispatch user: ${dispatch.email}`);

  // Create billing user
  const billing = await prisma.user.upsert({
    where: { email: 'billing@basinsafetyus.com' },
    update: {},
    create: {
      email: 'billing@basinsafetyus.com',
      name: 'Sample Billing/AR',
      role: 'billing_ar',
      passwordHash: await bcrypt.hash('billing123', 10),
    },
  });
  console.log(`  Billing user: ${billing.email}`);

  // Create sample companies (operators)
  const hess = await prisma.company.upsert({
    where: { id: 'co-hess' },
    update: { qbCustomerFullName: 'Hess Corporation' },
    create: { id: 'co-hess', name: 'Hess Corporation', companyType: 'operator', city: 'Minot', state: 'ND', isActive: true, qbCustomerFullName: 'Hess Corporation' },
  });
  const conoco = await prisma.company.upsert({
    where: { id: 'co-conoco' },
    update: { qbCustomerFullName: 'ConocoPhillips' },
    create: { id: 'co-conoco', name: 'ConocoPhillips', companyType: 'operator', city: 'Williston', state: 'ND', isActive: true, qbCustomerFullName: 'ConocoPhillips' },
  });
  const whiting = await prisma.company.upsert({
    where: { id: 'co-whiting' },
    update: { qbCustomerFullName: 'Whiting Petroleum' },
    create: { id: 'co-whiting', name: 'Whiting Petroleum', companyType: 'both', city: 'Dickinson', state: 'ND', isActive: true, qbCustomerFullName: 'Whiting Petroleum' },
  });
  const continental = await prisma.company.upsert({
    where: { id: 'co-continental' },
    update: { qbCustomerFullName: 'Continental Resources' },
    create: { id: 'co-continental', name: 'Continental Resources', companyType: 'operator', city: 'Watford City', state: 'ND', isActive: true, qbCustomerFullName: 'Continental Resources' },
  });
  const marathon = await prisma.company.upsert({
    where: { id: 'co-marathon' },
    update: { qbCustomerFullName: 'Marathon Oil' },
    create: { id: 'co-marathon', name: 'Marathon Oil', companyType: 'operator', city: 'Williston', state: 'ND', isActive: true, qbCustomerFullName: 'Marathon Oil' },
  });
  const oasis = await prisma.company.upsert({
    where: { id: 'co-oasis' },
    update: { qbCustomerFullName: 'Oasis Petroleum' },
    create: { id: 'co-oasis', name: 'Oasis Petroleum', companyType: 'both', city: 'Williston', state: 'ND', isActive: true, qbCustomerFullName: 'Oasis Petroleum' },
  });
  // Basin Safety (self — for internal shop orders, rentals, etc.)
  const basin = await prisma.company.upsert({
    where: { id: 'co-basin' },
    update: { qbCustomerFullName: 'Basin Safety' },
    create: { id: 'co-basin', name: 'Basin Safety', companyType: 'both', city: 'Williston', state: 'ND', isActive: true, qbCustomerFullName: 'Basin Safety' },
  });
  console.log(`  Companies: ${hess.name}, ${conoco.name}, ${whiting.name}, ${continental.name}, ${marathon.name}, ${oasis.name}, ${basin.name}`);

  // Create a few sample fields
  const sanish = await prisma.field.upsert({
    where: { id: 'field-sanish' },
    update: {},
    create: { id: 'field-sanish', name: 'SANISH', county: 'Mountrail', state: 'ND' },
  });
  const oliver = await prisma.field.upsert({
    where: { id: 'field-oliver' },
    update: {},
    create: { id: 'field-oliver', name: 'OLIVER', county: 'Williams', state: 'ND' },
  });
  const parshall = await prisma.field.upsert({
    where: { id: 'field-parshall' },
    update: {},
    create: { id: 'field-parshall', name: 'PARSHALL', county: 'Mountrail', state: 'ND' },
  });
  console.log(`  Fields: ${sanish.name}, ${oliver.name}, ${parshall.name}`);

  // Create sample pads
  const pad1 = await prisma.pad.upsert({
    where: { id: 'pad-tioga-1' },
    update: {},
    create: { id: 'pad-tioga-1', name: 'TIOGA 14-1H PAD', fieldId: 'field-sanish', currentOperatorId: 'co-hess' },
  });
  const pad2 = await prisma.pad.upsert({
    where: { id: 'pad-en-johnson' },
    update: {},
    create: { id: 'pad-en-johnson', name: 'EN-JOHNSON 21-4H PAD', fieldId: 'field-sanish', currentOperatorId: 'co-conoco' },
  });
  const pad3 = await prisma.pad.upsert({
    where: { id: 'pad-liberty' },
    update: {},
    create: { id: 'pad-liberty', name: 'LIBERTY 16-1 PAD', fieldId: 'field-oliver', currentOperatorId: 'co-whiting' },
  });
  const pad4 = await prisma.pad.upsert({
    where: { id: 'pad-montana' },
    update: {},
    create: { id: 'pad-montana', name: 'MONTANA 8-3H PAD', fieldId: 'field-parshall', currentOperatorId: 'co-continental' },
  });
  console.log(`  Pads: ${pad1.name}, ${pad2.name}, ${pad3.name}, ${pad4.name}`);

  // Create sample wells
  for (const well of [
    { id: 'well-tioga-1h', wellName: 'TIOGA 14-1H', padId: 'pad-tioga-1', fieldId: 'field-sanish', currentOperatorId: 'co-hess' },
    { id: 'well-tioga-2h', wellName: 'TIOGA 14-2H', padId: 'pad-tioga-1', fieldId: 'field-sanish', currentOperatorId: 'co-hess' },
    { id: 'well-johnson-4h', wellName: 'EN-JOHNSON 21-4H', padId: 'pad-en-johnson', fieldId: 'field-sanish', currentOperatorId: 'co-conoco' },
    { id: 'well-liberty-1', wellName: 'LIBERTY 16-1', padId: 'pad-liberty', fieldId: 'field-oliver', currentOperatorId: 'co-whiting' },
    { id: 'well-liberty-2', wellName: 'LIBERTY 16-2', padId: 'pad-liberty', fieldId: 'field-oliver', currentOperatorId: 'co-whiting' },
    { id: 'well-montana-3h', wellName: 'MONTANA 8-3H', padId: 'pad-montana', fieldId: 'field-parshall', currentOperatorId: 'co-continental' },
  ]) {
    await prisma.well.upsert({
      where: { id: well.id },
      update: {},
      create: { ...well, wellStatus: 'A', wellType: 'OG' },
    });
  }
  console.log('  Wells: 6 wells created');

  // Create work points (air system locations) for wells
  // customData.cylinders stores current known bottles on the cascade
  const workPoints = [
    {
      id: 'wp-tioga-1h-tb',
      name: 'Tank Battery #1',
      workPointType: 'air_system_location' as const,
      wellId: 'well-tioga-1h',
      hasSuppliedAir: true,
      reelSerialNumber: 'RL-2201-0045',
      standSerialNumber: 'ST-2201-0045',
      airSystemType: 'tank_battery',
      customData: { cylinders: [
        { serialNumber: 'CYL-4480-A', hydroDate: '2024-06-15', expiryDate: '2029-06-15' },
        { serialNumber: 'CYL-4480-B', hydroDate: '2024-06-15', expiryDate: '2029-06-15' },
        { serialNumber: 'CYL-4480-C', hydroDate: '2023-03-10', expiryDate: '2028-03-10' },
        { serialNumber: 'CYL-4480-D', hydroDate: '2023-03-10', expiryDate: '2028-03-10' },
      ]},
    },
    {
      id: 'wp-tioga-2h-tb',
      name: 'Tank Battery #2',
      workPointType: 'air_system_location' as const,
      wellId: 'well-tioga-2h',
      hasSuppliedAir: true,
      reelSerialNumber: 'RL-2201-0046',
      standSerialNumber: 'ST-2201-0046',
      airSystemType: 'tank_battery',
      customData: { cylinders: [
        { serialNumber: 'CYL-4481-A', hydroDate: '2024-08-20', expiryDate: '2029-08-20' },
        { serialNumber: 'CYL-4481-B', hydroDate: '2024-08-20', expiryDate: '2029-08-20' },
      ]},
    },
    {
      id: 'wp-johnson-comp',
      name: 'Compressor Station',
      workPointType: 'air_system_location' as const,
      wellId: 'well-johnson-4h',
      hasSuppliedAir: true,
      reelSerialNumber: 'RL-2303-0112',
      standSerialNumber: 'ST-2303-0112',
      airSystemType: 'compressor',
      customData: { cylinders: [
        { serialNumber: 'CYL-5590-A', hydroDate: '2025-01-12', expiryDate: '2030-01-12' },
        { serialNumber: 'CYL-5590-B', hydroDate: '2025-01-12', expiryDate: '2030-01-12' },
        { serialNumber: 'CYL-5590-C', hydroDate: '2024-11-05', expiryDate: '2029-11-05' },
      ]},
    },
    {
      id: 'wp-liberty-1-tb',
      name: 'Tank Battery',
      workPointType: 'air_system_location' as const,
      wellId: 'well-liberty-1',
      hasSuppliedAir: true,
      reelSerialNumber: 'RL-2105-0033',
      standSerialNumber: 'ST-2105-0033',
      airSystemType: 'oil_tank_battery',
      customData: { cylinders: [
        { serialNumber: 'CYL-3371-A', hydroDate: '2023-09-22', expiryDate: '2028-09-22' },
        { serialNumber: 'CYL-3371-B', hydroDate: '2023-09-22', expiryDate: '2028-09-22' },
        { serialNumber: 'CYL-3371-C', hydroDate: '2025-02-01', expiryDate: '2030-02-01' },
      ]},
    },
    {
      id: 'wp-liberty-2-swd',
      name: 'SWD Facility Air',
      workPointType: 'air_system_location' as const,
      wellId: 'well-liberty-2',
      hasSuppliedAir: true,
      reelSerialNumber: 'RL-2410-0078',
      standSerialNumber: 'ST-2410-0078',
      airSystemType: 'swd_facility',
      customData: { cylinders: [
        { serialNumber: 'CYL-6602-A', hydroDate: '2024-04-18', expiryDate: '2029-04-18' },
        { serialNumber: 'CYL-6602-B', hydroDate: '2024-04-18', expiryDate: '2029-04-18' },
      ]},
    },
    {
      id: 'wp-montana-tb',
      name: 'Tank Battery',
      workPointType: 'air_system_location' as const,
      wellId: 'well-montana-3h',
      hasSuppliedAir: true,
      reelSerialNumber: 'RL-2209-0061',
      standSerialNumber: 'ST-2209-0061',
      airSystemType: 'tank_battery',
      customData: { cylinders: [
        { serialNumber: 'CYL-2243-A', hydroDate: '2022-12-01', expiryDate: '2027-12-01' },
        { serialNumber: 'CYL-2243-B', hydroDate: '2022-12-01', expiryDate: '2027-12-01' },
        { serialNumber: 'CYL-2243-C', hydroDate: '2024-07-14', expiryDate: '2029-07-14' },
        { serialNumber: 'CYL-2243-D', hydroDate: '2024-07-14', expiryDate: '2029-07-14' },
      ]},
    },
  ];

  for (const wp of workPoints) {
    await prisma.workPoint.upsert({
      where: { id: wp.id },
      update: { customData: wp.customData },
      create: wp,
    });
  }
  console.log(`  WorkPoints: ${workPoints.length} air system locations`);

  // Create sample product categories
  const products = [
    { partNumber: 'LAB-REG', name: 'Regular Labor', category: 'labor' as const, productType: 'service' as const, unitOfMeasure: 'HR', isTaxable: false, qbItemFullName: 'Labor:Regular Labor' },
    { partNumber: 'LAB-OT', name: 'Overtime Labor', category: 'labor' as const, productType: 'service' as const, unitOfMeasure: 'HR', isTaxable: false, qbItemFullName: 'Labor:Overtime Labor' },
    { partNumber: 'LAB-TRAVEL', name: 'Travel Time', category: 'labor' as const, productType: 'service' as const, unitOfMeasure: 'HR', isTaxable: false, qbItemFullName: 'Labor:Travel Time' },
    { partNumber: 'FIT-TEST', name: 'Fit Test (per person)', category: 'labor' as const, productType: 'service' as const, unitOfMeasure: 'EA', isTaxable: false, defaultSellPrice: 35.00, qbItemFullName: 'Labor:Fit Test' },
    { partNumber: 'MON-RAE-G7', name: 'Blackline Safety G7 Personal Monitor', category: 'monitor_personal' as const, productType: 'both' as const, unitOfMeasure: 'EA', isSerialized: true, isTaxable: true, qbItemFullName: 'Monitors:Blackline Safety G7' },
    { partNumber: 'MON-RAE-MX6', name: 'RAE MX6 iBrid 6-Gas Monitor', category: 'monitor_personal' as const, productType: 'both' as const, unitOfMeasure: 'EA', isSerialized: true, isTaxable: true, qbItemFullName: 'Monitors:RAE MX6 iBrid' },
    { partNumber: 'SEN-LEL', name: 'LEL Replacement Sensor', category: 'sensor' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Sensors:LEL Sensor' },
    { partNumber: 'SEN-O2', name: 'O2 Replacement Sensor', category: 'sensor' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Sensors:O2 Sensor' },
    { partNumber: 'SEN-H2S', name: 'H₂S Replacement Sensor', category: 'sensor' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Sensors:H2S Sensor' },
    { partNumber: 'SEN-CO', name: 'CO Replacement Sensor', category: 'sensor' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Sensors:CO Sensor' },
    { partNumber: 'SEN-VOC', name: 'VOC/PID Replacement Sensor', category: 'sensor' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Sensors:VOC PID Sensor' },
    { partNumber: 'SEN-SO2', name: 'SO₂ Replacement Sensor', category: 'sensor' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Sensors:SO2 Sensor' },
    { partNumber: 'SEN-NH3', name: 'NH₃ Replacement Sensor', category: 'sensor' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Sensors:NH3 Sensor' },
    { partNumber: 'CAL-4GAS', name: '4-Gas Calibration Gas Cylinder', category: 'calibration_gas' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Cal Gas:4-Gas Cylinder' },
    { partNumber: 'CAL-5GAS', name: '5-Gas Calibration Gas Cylinder', category: 'calibration_gas' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Cal Gas:5-Gas Cylinder' },
    { partNumber: 'CAL-REGULATOR', name: 'Cal Gas Regulator', category: 'calibration_gas' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Cal Gas:Regulator' },
    // Shop labor
    { partNumber: 'LAB-SHOP', name: 'Shop Labor', category: 'labor' as const, productType: 'service' as const, unitOfMeasure: 'HR', isTaxable: false, qbItemFullName: 'Labor:Shop Labor' },
    { partNumber: 'LAB-DIAG', name: 'Diagnostic / Bench Time', category: 'labor' as const, productType: 'service' as const, unitOfMeasure: 'HR', isTaxable: false, qbItemFullName: 'Labor:Diagnostic Bench Time' },
    // FEX parts
    { partNumber: 'FEX-RECHARGE-ABC', name: 'FEX Recharge - ABC', category: 'consumable' as const, productType: 'service' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Fire Ext:Recharge ABC' },
    { partNumber: 'FEX-RECHARGE-PURK', name: 'FEX Recharge - Purple K', category: 'consumable' as const, productType: 'service' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Fire Ext:Recharge Purple K' },
    { partNumber: 'FEX-VALVE', name: 'FEX Valve Assembly', category: 'consumable' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Fire Ext:Valve Assembly' },
    { partNumber: 'FEX-GAUGE', name: 'FEX Pressure Gauge', category: 'consumable' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Fire Ext:Pressure Gauge' },
    { partNumber: 'FEX-HOSE', name: 'FEX Hose Assembly', category: 'consumable' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Fire Ext:Hose Assembly' },
    { partNumber: 'FEX-ORING', name: 'FEX O-Ring Kit', category: 'consumable' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Fire Ext:O-Ring Kit' },
    { partNumber: 'FEX-PIN', name: 'FEX Safety Pin & Tamper Seal', category: 'consumable' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Fire Ext:Safety Pin Tamper Seal' },
    { partNumber: 'FEX-LABEL', name: 'FEX Inspection Tag/Label', category: 'consumable' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Fire Ext:Inspection Tag' },
    { partNumber: 'FEX-HYDRO', name: 'FEX Hydrostatic Test', category: 'labor' as const, productType: 'service' as const, unitOfMeasure: 'EA', isTaxable: false, qbItemFullName: 'Fire Ext:Hydrostatic Test' },
    // Monitor accessories
    { partNumber: 'ACC-PUMP', name: 'Sample Pump Assembly', category: 'accessory' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Accessories:Sample Pump' },
    { partNumber: 'ACC-FILTER', name: 'Filter Assembly / Dust Cap', category: 'accessory' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Accessories:Filter Assembly' },
    { partNumber: 'ACC-BATTERY', name: 'Replacement Battery Pack', category: 'accessory' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Accessories:Battery Pack' },
    { partNumber: 'ACC-CLIP', name: 'Alligator Clip / Belt Clip', category: 'accessory' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Accessories:Belt Clip' },
    { partNumber: 'ACC-CHARGER', name: 'Charging Cradle / USB Charger', category: 'accessory' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Accessories:Charger' },
    // Fall arrest / SCBA
    { partNumber: 'FA-WEBBING', name: 'Harness Webbing Replacement', category: 'consumable' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Fall Arrest:Webbing Replacement' },
    { partNumber: 'FA-BUCKLE', name: 'Harness Buckle / D-Ring', category: 'consumable' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Fall Arrest:Buckle D-Ring' },
    { partNumber: 'SCBA-REGULATOR', name: 'SCBA Regulator Rebuild Kit', category: 'consumable' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'SCBA:Regulator Rebuild Kit' },
    { partNumber: 'SCBA-MASK-SEAL', name: 'SCBA Mask Seal / Gasket', category: 'consumable' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'SCBA:Mask Seal Gasket' },
    { partNumber: 'SCBA-HYDRO', name: 'SCBA Cylinder Hydrostatic Test', category: 'labor' as const, productType: 'service' as const, unitOfMeasure: 'EA', isTaxable: false, qbItemFullName: 'SCBA:Hydrostatic Test' },
    // Misc
    { partNumber: 'MISC-SHIPPING', name: 'Shipping / Freight Charge', category: 'misc' as const, productType: 'service' as const, unitOfMeasure: 'EA', isTaxable: false, qbItemFullName: 'Misc:Shipping Freight' },
    { partNumber: 'MISC-PART', name: 'Miscellaneous Part', category: 'misc' as const, productType: 'sale' as const, unitOfMeasure: 'EA', isTaxable: true, qbItemFullName: 'Misc:Miscellaneous Part' },
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { partNumber: p.partNumber },
      update: { qbItemFullName: p.qbItemFullName },
      create: p,
    });
  }
  console.log(`  Products: ${products.length} items`);

  // ============================================================
  // Rental Equipment: Products, Serialized Equipment, Assemblies
  // ============================================================

  // -- Rental products: personal monitors with rental rates --
  const rentalProducts = [
    {
      partNumber: 'MON-BW-MICRO5',
      name: 'BW MicroClip X5 4-Gas Personal Monitor',
      category: 'monitor_personal' as const,
      productType: 'rental' as const,
      unitOfMeasure: 'EA',
      isSerialized: true,
      isTaxable: true,
      defaultRentalRateDaily: 25,
      defaultRentalRateWeekly: 125,
      defaultRentalRateMonthly: 400,
      qbItemFullName: 'Monitors:BW MicroClip X5',
    },
    {
      partNumber: 'MON-BW-ULTRA',
      name: 'Honeywell BW Ultra 5-Gas Monitor',
      category: 'monitor_personal' as const,
      productType: 'rental' as const,
      unitOfMeasure: 'EA',
      isSerialized: true,
      isTaxable: true,
      defaultRentalRateDaily: 35,
      defaultRentalRateWeekly: 175,
      defaultRentalRateMonthly: 550,
      qbItemFullName: 'Monitors:BW Ultra 5-Gas',
    },
    // -- Area monitors --
    {
      partNumber: 'MON-AREA-RAE5',
      name: 'RAE AreaRAE 5-Gas Area Monitor',
      category: 'monitor_area' as const,
      productType: 'rental' as const,
      unitOfMeasure: 'EA',
      isSerialized: true,
      isTaxable: true,
      defaultRentalRateDaily: 75,
      defaultRentalRateWeekly: 375,
      defaultRentalRateMonthly: 1200,
      qbItemFullName: 'Monitors:AreaRAE 5-Gas',
    },
    {
      partNumber: 'MON-AREA-BW',
      name: 'BW RigRat Area Monitor',
      category: 'monitor_area' as const,
      productType: 'rental' as const,
      unitOfMeasure: 'EA',
      isSerialized: true,
      isTaxable: true,
      defaultRentalRateDaily: 65,
      defaultRentalRateWeekly: 325,
      defaultRentalRateMonthly: 1000,
      qbItemFullName: 'Monitors:BW RigRat Area',
    },
    // -- Trailer (assembly) — named by PSI rating --
    {
      partNumber: 'TRL-2400',
      name: 'Basin 2400 PSI Supplied Air Trailer',
      category: 'assembly' as const,
      productType: 'rental' as const,
      unitOfMeasure: 'EA',
      isSerialized: true,
      isAssembly: true,
      isTaxable: true,
      defaultRentalRateDaily: 225,
      defaultRentalRateWeekly: 1125,
      defaultRentalRateMonthly: 3500,
      qbItemFullName: 'Rentals:2400 PSI Air Trailer',
    },
    {
      partNumber: 'TRL-4500',
      name: 'Basin 4500 PSI Supplied Air Trailer',
      category: 'assembly' as const,
      productType: 'rental' as const,
      unitOfMeasure: 'EA',
      isSerialized: true,
      isAssembly: true,
      isTaxable: true,
      defaultRentalRateDaily: 275,
      defaultRentalRateWeekly: 1375,
      defaultRentalRateMonthly: 4500,
      qbItemFullName: 'Rentals:4500 PSI Air Trailer',
    },
    {
      partNumber: 'TRL-10000',
      name: 'Basin 10000 PSI Supplied Air Trailer',
      category: 'assembly' as const,
      productType: 'rental' as const,
      unitOfMeasure: 'EA',
      isSerialized: true,
      isAssembly: true,
      isTaxable: true,
      defaultRentalRateDaily: 350,
      defaultRentalRateWeekly: 1750,
      defaultRentalRateMonthly: 5500,
      qbItemFullName: 'Rentals:10000 PSI Air Trailer',
    },
    // -- Trailer sub-components (supplied air components) --
    {
      partNumber: 'AIR-TANK-30',
      name: 'Breathable Air Tank',
      category: 'supplied_air_component' as const,
      productType: 'both' as const,
      unitOfMeasure: 'EA',
      isSerialized: true,
      isTaxable: true,
      qbItemFullName: 'Air Supply:30-Min SCBA Cylinder',
    },
    {
      partNumber: 'AIR-HOSE-50',
      name: '50ft Supplied Air Hose',
      category: 'supplied_air_component' as const,
      productType: 'both' as const,
      unitOfMeasure: 'EA',
      isSerialized: false,
      isTaxable: true,
      qbItemFullName: 'Air Supply:50ft Air Hose',
    },
    {
      partNumber: 'AIR-MASK-FF',
      name: 'Full Face Supplied Air Mask',
      category: 'supplied_air_component' as const,
      productType: 'both' as const,
      unitOfMeasure: 'EA',
      isSerialized: true,
      isTaxable: true,
      qbItemFullName: 'Air Supply:Full Face Mask',
    },
    {
      partNumber: 'AIR-REG-MSA',
      name: 'MSA Pressure Regulator',
      category: 'supplied_air_component' as const,
      productType: 'both' as const,
      unitOfMeasure: 'EA',
      isSerialized: true,
      isTaxable: true,
      qbItemFullName: 'Air Supply:MSA Regulator',
    },
    {
      partNumber: 'AIR-PACK-30ESC',
      name: '30-Min Escape Pack (SCBA + mask)',
      category: 'supplied_air_component' as const,
      productType: 'both' as const,
      unitOfMeasure: 'EA',
      isSerialized: true,
      isAssembly: true,
      isTaxable: true,
      qbItemFullName: 'Air Supply:30-Min Escape Pack',
    },
  ];

  const rentalProductRecords: Record<string, any> = {};
  for (const p of rentalProducts) {
    const created = await prisma.product.upsert({
      where: { partNumber: p.partNumber },
      update: {
        defaultRentalRateDaily: p.defaultRentalRateDaily,
        defaultRentalRateWeekly: p.defaultRentalRateWeekly,
        defaultRentalRateMonthly: p.defaultRentalRateMonthly,
        qbItemFullName: p.qbItemFullName,
      },
      create: p,
    });
    rentalProductRecords[p.partNumber] = created;
  }
  console.log(`  Rental Products: ${rentalProducts.length} items`);

  // Also update existing monitor products with rental rates
  await prisma.product.update({
    where: { partNumber: 'MON-RAE-G7' },
    data: { defaultRentalRateDaily: 30, defaultRentalRateWeekly: 150, defaultRentalRateMonthly: 475, productType: 'both' },
  });
  await prisma.product.update({
    where: { partNumber: 'MON-RAE-MX6' },
    data: { defaultRentalRateDaily: 28, defaultRentalRateWeekly: 140, defaultRentalRateMonthly: 450, productType: 'both' },
  });
  console.log('  Updated existing monitors with rental rates');

  // -- Assembly components: what's inside each trailer --
  const trl2400 = rentalProductRecords['TRL-2400'];
  const trl4500 = rentalProductRecords['TRL-4500'];
  const trl10000 = rentalProductRecords['TRL-10000'];
  const tank30 = rentalProductRecords['AIR-TANK-30'];
  const hose50 = rentalProductRecords['AIR-HOSE-50'];
  const maskFF = rentalProductRecords['AIR-MASK-FF'];
  const regMSA = rentalProductRecords['AIR-REG-MSA'];
  const pack30 = rentalProductRecords['AIR-PACK-30ESC'];

  // 2400 PSI trailer contents (4-bottle)
  const trailer2400Components = [
    { assemblyProductId: trl2400.id, componentProductId: tank30.id, quantityPerAssembly: 4, sortOrder: 1, isOptional: false },
    { assemblyProductId: trl2400.id, componentProductId: hose50.id, quantityPerAssembly: 2, sortOrder: 2, isOptional: false },
    { assemblyProductId: trl2400.id, componentProductId: maskFF.id, quantityPerAssembly: 2, sortOrder: 3, isOptional: false },
    { assemblyProductId: trl2400.id, componentProductId: regMSA.id, quantityPerAssembly: 2, sortOrder: 4, isOptional: false },
    { assemblyProductId: trl2400.id, componentProductId: pack30.id, quantityPerAssembly: 2, sortOrder: 5, isOptional: true },
  ];

  // 4500 PSI trailer contents (4-bottle)
  const trailer4500Components = [
    { assemblyProductId: trl4500.id, componentProductId: tank30.id, quantityPerAssembly: 4, sortOrder: 1, isOptional: false },
    { assemblyProductId: trl4500.id, componentProductId: hose50.id, quantityPerAssembly: 2, sortOrder: 2, isOptional: false },
    { assemblyProductId: trl4500.id, componentProductId: maskFF.id, quantityPerAssembly: 2, sortOrder: 3, isOptional: false },
    { assemblyProductId: trl4500.id, componentProductId: regMSA.id, quantityPerAssembly: 2, sortOrder: 4, isOptional: false },
    { assemblyProductId: trl4500.id, componentProductId: pack30.id, quantityPerAssembly: 2, sortOrder: 5, isOptional: true },
  ];

  // 10000 PSI trailer contents (6-bottle)
  const trailer10000Components = [
    { assemblyProductId: trl10000.id, componentProductId: tank30.id, quantityPerAssembly: 6, sortOrder: 1, isOptional: false },
    { assemblyProductId: trl10000.id, componentProductId: hose50.id, quantityPerAssembly: 2, sortOrder: 2, isOptional: false },
    { assemblyProductId: trl10000.id, componentProductId: maskFF.id, quantityPerAssembly: 2, sortOrder: 3, isOptional: false },
    { assemblyProductId: trl10000.id, componentProductId: regMSA.id, quantityPerAssembly: 2, sortOrder: 4, isOptional: false },
    { assemblyProductId: trl10000.id, componentProductId: pack30.id, quantityPerAssembly: 2, sortOrder: 5, isOptional: true },
  ];

  // Clear and re-create assembly components for these trailers
  await prisma.assemblyComponent.deleteMany({ where: { assemblyProductId: { in: [trl2400.id, trl4500.id, trl10000.id] } } });
  for (const comp of [...trailer2400Components, ...trailer4500Components, ...trailer10000Components]) {
    await prisma.assemblyComponent.create({ data: comp });
  }
  console.log('  Assembly components: TRL-2400 (4-bottle), TRL-4500 (4-bottle), TRL-10000 (6-bottle)');

  // -- Serialized Equipment: personal monitors, area monitors, trailers --

  const equipmentList = [
    // Personal monitors - BW MicroClip X5
    { serialNumber: 'MC5-2024-001', productPartNumber: 'MON-BW-MICRO5', status: 'available' as const },
    { serialNumber: 'MC5-2024-002', productPartNumber: 'MON-BW-MICRO5', status: 'available' as const },
    { serialNumber: 'MC5-2024-003', productPartNumber: 'MON-BW-MICRO5', status: 'available' as const },
    { serialNumber: 'MC5-2024-004', productPartNumber: 'MON-BW-MICRO5', status: 'available' as const },
    { serialNumber: 'MC5-2024-005', productPartNumber: 'MON-BW-MICRO5', status: 'available' as const },
    { serialNumber: 'MC5-2023-010', productPartNumber: 'MON-BW-MICRO5', status: 'available' as const },
    { serialNumber: 'MC5-2023-011', productPartNumber: 'MON-BW-MICRO5', status: 'available' as const },
    { serialNumber: 'MC5-2023-012', productPartNumber: 'MON-BW-MICRO5', status: 'available' as const },
    // Personal monitors - BW Ultra
    { serialNumber: 'BWU-2024-101', productPartNumber: 'MON-BW-ULTRA', status: 'available' as const },
    { serialNumber: 'BWU-2024-102', productPartNumber: 'MON-BW-ULTRA', status: 'available' as const },
    { serialNumber: 'BWU-2024-103', productPartNumber: 'MON-BW-ULTRA', status: 'available' as const },
    { serialNumber: 'BWU-2023-090', productPartNumber: 'MON-BW-ULTRA', status: 'available' as const },
    // Personal monitors - existing products (G7, MX6)
    { serialNumber: 'G7-2024-201', productPartNumber: 'MON-RAE-G7', status: 'available' as const },
    { serialNumber: 'G7-2024-202', productPartNumber: 'MON-RAE-G7', status: 'available' as const },
    { serialNumber: 'G7-2024-203', productPartNumber: 'MON-RAE-G7', status: 'available' as const },
    { serialNumber: 'MX6-2024-301', productPartNumber: 'MON-RAE-MX6', status: 'available' as const },
    { serialNumber: 'MX6-2024-302', productPartNumber: 'MON-RAE-MX6', status: 'available' as const },
    // Area monitors - AreaRAE
    { serialNumber: 'ARAE-2024-001', productPartNumber: 'MON-AREA-RAE5', status: 'available' as const },
    { serialNumber: 'ARAE-2024-002', productPartNumber: 'MON-AREA-RAE5', status: 'available' as const },
    { serialNumber: 'ARAE-2023-008', productPartNumber: 'MON-AREA-RAE5', status: 'available' as const },
    // Area monitors - RigRat
    { serialNumber: 'RRAT-2024-001', productPartNumber: 'MON-AREA-BW', status: 'available' as const },
    { serialNumber: 'RRAT-2024-002', productPartNumber: 'MON-AREA-BW', status: 'available' as const },
    // Trailers - 2400 PSI
    { serialNumber: 'TRL2400-001', productPartNumber: 'TRL-2400', status: 'available' as const },
    { serialNumber: 'TRL2400-002', productPartNumber: 'TRL-2400', status: 'available' as const },
    // Trailers - 4500 PSI
    { serialNumber: 'TRL4500-001', productPartNumber: 'TRL-4500', status: 'available' as const },
    // Trailers - 10000 PSI
    { serialNumber: 'TRL10K-001', productPartNumber: 'TRL-10000', status: 'available' as const },
    { serialNumber: 'TRL10K-002', productPartNumber: 'TRL-10000', status: 'available' as const },
    // Escape packs
    { serialNumber: 'ESC-2024-001', productPartNumber: 'AIR-PACK-30ESC', status: 'available' as const },
    { serialNumber: 'ESC-2024-002', productPartNumber: 'AIR-PACK-30ESC', status: 'available' as const },
    { serialNumber: 'ESC-2024-003', productPartNumber: 'AIR-PACK-30ESC', status: 'available' as const },
    { serialNumber: 'ESC-2024-004', productPartNumber: 'AIR-PACK-30ESC', status: 'available' as const },
    // Masks
    { serialNumber: 'MASK-2024-A01', productPartNumber: 'AIR-MASK-FF', status: 'available' as const },
    { serialNumber: 'MASK-2024-A02', productPartNumber: 'AIR-MASK-FF', status: 'available' as const },
    { serialNumber: 'MASK-2024-A03', productPartNumber: 'AIR-MASK-FF', status: 'available' as const },
    { serialNumber: 'MASK-2024-A04', productPartNumber: 'AIR-MASK-FF', status: 'available' as const },
    // Regulators
    { serialNumber: 'REG-MSA-001', productPartNumber: 'AIR-REG-MSA', status: 'available' as const },
    { serialNumber: 'REG-MSA-002', productPartNumber: 'AIR-REG-MSA', status: 'available' as const },
    { serialNumber: 'REG-MSA-003', productPartNumber: 'AIR-REG-MSA', status: 'available' as const },
    // 30-min cylinders (a few serialized)
    { serialNumber: 'CYL30-2024-001', productPartNumber: 'AIR-TANK-30', status: 'available' as const },
    { serialNumber: 'CYL30-2024-002', productPartNumber: 'AIR-TANK-30', status: 'available' as const },
    { serialNumber: 'CYL30-2024-003', productPartNumber: 'AIR-TANK-30', status: 'available' as const },
    { serialNumber: 'CYL30-2024-004', productPartNumber: 'AIR-TANK-30', status: 'available' as const },
  ];

  for (const equip of equipmentList) {
    const product = await prisma.product.findUnique({ where: { partNumber: equip.productPartNumber }, select: { id: true } });
    if (!product) { console.log(`  ⚠ Product ${equip.productPartNumber} not found, skipping ${equip.serialNumber}`); continue; }
    await prisma.serializedEquipment.upsert({
      where: { serialNumber: equip.serialNumber },
      update: {},
      create: {
        serialNumber: equip.serialNumber,
        productId: product.id,
        ownership: 'basin_safety',
        status: equip.status,
        calibrationDueDate: new Date('2026-06-30'),
        lastCalibrationDate: new Date('2025-12-15'),
      },
    });
  }
  console.log(`  Serialized Equipment: ${equipmentList.length} units`);

  // -- Sample active rental agreements --

  // Agreement 1: Hess renting 3 personal monitors + 1 area monitor
  const hessMonitors = await prisma.serializedEquipment.findMany({
    where: { serialNumber: { in: ['MC5-2024-001', 'MC5-2024-002', 'MC5-2024-003', 'ARAE-2024-001'] } },
    include: { product: { select: { id: true, partNumber: true } } },
  });

  if (hessMonitors.length === 4) {
    const ra1Number = 'RA-2026-0001';
    const ra1 = await prisma.rentalAgreement.upsert({
      where: { agreementNumber: ra1Number },
      update: {},
      create: {
        agreementNumber: ra1Number,
        companyId: 'co-hess',
        fieldId: 'field-sanish',
        padId: 'pad-tioga-1',
        status: 'active',
        startDate: new Date('2026-02-01'),
        billingRateType: 'weekly',
        poNumber: 'HESS-PO-2026-114',
        isManned: true,
        isRigJob: false,
        monitorsIncluded: true,
        notes: '3 personal + 1 area for frac crew',
      },
    });
    for (const equip of hessMonitors) {
      const isArea = equip.product.partNumber.startsWith('MON-AREA');
      await prisma.rentalAgreementItem.create({
        data: {
          rentalAgreementId: ra1.id,
          productId: equip.product.id,
          serializedEquipmentId: equip.id,
          rate: isArea ? 375 : 125,
          rateType: 'weekly',
          deployedDate: new Date('2026-02-01'),
          status: 'deployed',
        },
      });
      await prisma.serializedEquipment.update({
        where: { id: equip.id },
        data: { status: 'rented', currentRentalId: ra1.id, currentCustomerId: 'co-hess' },
      });
    }
    console.log(`  Rental Agreement: ${ra1Number} (Hess - 3 personal + 1 area monitor)`);
  }

  // Agreement 2: Continental renting a 10000 PSI trailer
  const contTrailer = await prisma.serializedEquipment.findFirst({
    where: { serialNumber: 'TRL10K-001' },
    include: { product: { select: { id: true } } },
  });

  if (contTrailer) {
    const ra2Number = 'RA-2026-0002';
    const ra2 = await prisma.rentalAgreement.upsert({
      where: { agreementNumber: ra2Number },
      update: {},
      create: {
        agreementNumber: ra2Number,
        companyId: 'co-continental',
        fieldId: 'field-parshall',
        padId: 'pad-montana',
        status: 'active',
        startDate: new Date('2026-01-15'),
        billingRateType: 'monthly',
        poNumber: 'CLR-AFE-8823',
        afeNumber: 'AFE-8823',
        isManned: false,
        isRigJob: false,
        monitorsIncluded: false,
        notes: 'Unmanned 10000 PSI supplied-air trailer for MONTANA 8-3H workover',
      },
    });
    await prisma.rentalAgreementItem.create({
      data: {
        rentalAgreementId: ra2.id,
        productId: contTrailer.product.id,
        serializedEquipmentId: contTrailer.id,
        rate: 5500,
        rateType: 'monthly',
        deployedDate: new Date('2026-01-15'),
        status: 'deployed',
      },
    });
    await prisma.serializedEquipment.update({
      where: { id: contTrailer.id },
      data: { status: 'rented', currentRentalId: ra2.id, currentCustomerId: 'co-continental' },
    });
    console.log(`  Rental Agreement: ${ra2Number} (Continental - 10000 PSI trailer)`);
  }

  // Agreement 3: Completed rental (Marathon returned monitors last week)
  const marathonMonitors = await prisma.serializedEquipment.findMany({
    where: { serialNumber: { in: ['BWU-2024-101', 'BWU-2024-102'] } },
    include: { product: { select: { id: true } } },
  });

  if (marathonMonitors.length === 2) {
    const ra3Number = 'RA-2026-0003';
    const ra3 = await prisma.rentalAgreement.upsert({
      where: { agreementNumber: ra3Number },
      update: {},
      create: {
        agreementNumber: ra3Number,
        companyId: 'co-marathon',
        fieldId: 'field-oliver',
        status: 'completed',
        startDate: new Date('2026-01-06'),
        endDate: new Date('2026-02-14'),
        billingRateType: 'weekly',
        poNumber: 'MRO-4401',
        isManned: true,
        isRigJob: false,
        monitorsIncluded: false,
        notes: '2 BW Ultra for pipeline crew - returned in good condition',
      },
    });
    for (const equip of marathonMonitors) {
      await prisma.rentalAgreementItem.create({
        data: {
          rentalAgreementId: ra3.id,
          productId: equip.product.id,
          serializedEquipmentId: equip.id,
          rate: 175,
          rateType: 'weekly',
          deployedDate: new Date('2026-01-06'),
          returnedDate: new Date('2026-02-14'),
          status: 'returned',
        },
      });
      // These are returned so equipment stays available (default)
    }
    console.log(`  Rental Agreement: ${ra3Number} (Marathon - completed, 2 BW Ultra returned)`);
  }

  // ─── Google Role Mappings ───────────────────────────────────
  const roleMappings = [
    { googleGroupEmail: 'sundog.admin@basinsafetyus.com',    sundogRole: 'platform_admin' as const, priority: 100 },
    { googleGroupEmail: 'sundog.super@basinsafetyus.com',    sundogRole: 'field_super' as const,    priority: 80 },
    { googleGroupEmail: 'sundog.billing@basinsafetyus.com',  sundogRole: 'billing_ar' as const,     priority: 60 },
    { googleGroupEmail: 'sundog.dispatch@basinsafetyus.com', sundogRole: 'dispatch' as const,       priority: 40 },
    { googleGroupEmail: 'sundog.tech@basinsafetyus.com',     sundogRole: 'field_tech' as const,     priority: 20 },
  ];

  for (const m of roleMappings) {
    await prisma.googleRoleMapping.upsert({
      where: { googleGroupEmail: m.googleGroupEmail },
      update: { sundogRole: m.sundogRole, priority: m.priority },
      create: m,
    });
  }
  console.log(`  Google Role Mappings: ${roleMappings.length} group→role mappings`);

  console.log('Seed complete.');
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error('Seed error:', e);
    prisma.$disconnect();
    process.exit(1);
  });
