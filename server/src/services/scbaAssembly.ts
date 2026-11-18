import { Prisma } from '../db.js';
import { AppError } from '../middleware/errorHandler.js';

export function parseScbaAssembly(body: any) {
  if (![5, 30].includes(body.durationMinutes)) throw new AppError(400, 'Choose a 5-minute or 30-minute SCBA pack');
  const serial = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const caseId = serial(body.caseId);
  const regulatorSerial = serial(body.regulatorSerial);
  const tankSerial = serial(body.tankSerial);
  if (!caseId) throw new AppError(400, 'Case ID is required');
  const serials = [caseId, regulatorSerial, tankSerial].filter(Boolean);
  if (new Set(serials).size !== serials.length) throw new AppError(400, 'Case, regulator, and tank must have different IDs');
  function date(value: unknown, label: string): string | null {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
      throw new AppError(400, `${label} must be a valid calendar date`);
    }
    return value;
  }
  const hydroDate = date(body.hydroDate, 'Hydro date');
  if (hydroDate && !tankSerial) throw new AppError(400, 'Enter the tank serial for its hydro date');
  return { durationMinutes: body.durationMinutes as 5 | 30, caseId, regulatorSerial, tankSerial,
    posiCheckDate: date(body.posiCheckDate, 'Posi-check date'), hydroDate };
}

const jsonObject = (value: unknown): Record<string, Prisma.InputJsonValue> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Prisma.InputJsonValue> : {};

/** Pack and physical subparts are saved together so a failed serial never leaves half a pack. */
export async function saveScbaAssembly(tx: Prisma.TransactionClient, body: any, id?: string) {
  const input = parseScbaAssembly(body);
  const existing = id ? await tx.serializedEquipment.findUnique({
    where: { id }, include: { childEquipment: true },
  }) : null;
  if (id && !existing) throw new AppError(404, 'Equipment not found');
  const product = await tx.product.upsert({
    where: { partNumber: `SP-SCBA-${input.durationMinutes}-PACK` },
    update: {},
    create: { partNumber: `SP-SCBA-${input.durationMinutes}-PACK`, name: `SCBA ${input.durationMinutes} min Pack`,
      category: 'supplied_air_component', productType: 'rental', isSerialized: true, isAssembly: true },
  });
  const data = { serialNumber: input.caseId, productId: product.id,
    ...(body.ownership !== undefined ? { ownership: body.ownership } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.conditionNotes !== undefined ? { conditionNotes: body.conditionNotes || null } : {}),
    ...(body.calibrationDueDate !== undefined ? { calibrationDueDate: body.calibrationDueDate ? new Date(body.calibrationDueDate) : null } : {}),
    customData: { ...jsonObject(existing?.customData), scba: { durationMinutes: input.durationMinutes, posiCheckDate: input.posiCheckDate } } };
  const pack = existing
    ? await tx.serializedEquipment.update({ where: { id: existing.id }, data })
    : await tx.serializedEquipment.create({ data: { ...data, ownership: body.ownership || 'basin_safety',
      status: body.status || 'available', conditionNotes: body.conditionNotes || null,
      purchaseDate: body.purchaseDate ? new Date(body.purchaseDate) : null } });

  for (const role of ['regulator', 'tank'] as const) {
    const serialNumber = role === 'regulator' ? input.regulatorSerial : input.tankSerial;
    const child = existing?.childEquipment.find(c => jsonObject(c.customData).scbaComponent === role);
    if (!serialNumber) {
      // Clearing a component unlinks the physical unit; its service history survives.
      if (child) await tx.serializedEquipment.update({ where: { id: child.id }, data: { parentEquipmentId: null } });
      continue;
    }
    const occupied = await tx.serializedEquipment.findUnique({ where: { serialNumber }, include: { product: true } });
    if (occupied && occupied.id !== child?.id) {
      const correctType = occupied.product?.category === 'supplied_air_component' && !occupied.product.isAssembly &&
        (role === 'tank' ? /tank|cylinder|bottle/i : /regulator/i).test(occupied.product.name);
      const available = occupied.parentEquipmentId === pack.id ||
        (!occupied.parentEquipmentId && occupied.status === 'available' && !occupied.currentRentalId);
      if (!correctType || !available || occupied.ownership !== pack.ownership) {
        throw new AppError(409, `Serial ${serialNumber} already exists and is not an available ${role} for this pack`);
      }
    }
    const componentProduct = await tx.product.upsert({
      where: { partNumber: `SP-SCBA-${role.toUpperCase()}` }, update: {},
      create: { partNumber: `SP-SCBA-${role.toUpperCase()}`, name: role === 'tank' ? 'SCBA Tank Cylinder' : 'SCBA Regulator',
        category: 'supplied_air_component', productType: 'rental', isSerialized: true },
    });
    const componentData = { serialNumber, parentEquipmentId: pack.id,
      ...(role === 'tank' ? { lastCalibrationDate: input.hydroDate ? new Date(input.hydroDate) : null } : {}) };
    if (child?.serialNumber === serialNumber) await tx.serializedEquipment.update({ where: { id: child.id }, data: componentData });
    else {
      if (child) await tx.serializedEquipment.update({ where: { id: child.id }, data: { parentEquipmentId: null } });
      if (occupied) await tx.serializedEquipment.update({ where: { id: occupied.id }, data: {
        ...componentData, status: pack.status, customData: { ...jsonObject(occupied.customData), scbaComponent: role },
      } });
      else await tx.serializedEquipment.create({ data: { ...componentData, productId: componentProduct.id,
        ownership: pack.ownership, status: pack.status, customData: { scbaComponent: role } } });
    }
  }
  return pack;
}
