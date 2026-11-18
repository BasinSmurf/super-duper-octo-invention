import type { RentalComposition } from './rentalComposition.js';

/** Customer-facing rental documentation, separate from monetary QB lines. */
export function rentalInvoiceNoteLines(
  periodStart: Date | null,
  periodEnd: Date | null,
  items: Array<{
    deployedDate: Date;
    returnedDate: Date | null;
    product: { name: string };
    serializedEquipment: { serialNumber: string; safeCoreSerial?: string | null };
  }>,
  tickets: Array<{ serviceDate: Date; customData: unknown }> = [],
  snapshot?: unknown,
): string[] {
  if (!periodStart || !periodEnd) return [];
  const format = (date: Date) => {
    const [year, month, day] = date.toISOString().slice(0, 10).split('-');
    return `${month}/${day}/${year}`;
  };
  const equipment = items
    .filter(item => item.deployedDate <= periodEnd && (!item.returnedDate || item.returnedDate >= periodStart))
    .map(item => {
      const serial = item.serializedEquipment.serialNumber.trim();
      const safeCore = item.serializedEquipment.safeCoreSerial?.trim();
      if (!serial && !safeCore) return null;
      return `Equipment: ${item.product.name} - ${serial || safeCore}${serial && safeCore && serial !== safeCore ? ` / SafeCore #${safeCore}` : ''}`;
    })
    .filter((line): line is string => line !== null);
  const manual: string[] = [];
  for (const ticket of tickets) {
    const data = ticket.customData as { workType?: string; manualEquipment?: Array<{ type?: string; serial?: string; deployedAt?: string }> } | null;
    if (data?.workType !== 'rental_deploy' || !Array.isArray(data.manualEquipment)) continue;
    for (const item of data.manualEquipment) {
      const deployed = item.deployedAt ? new Date(item.deployedAt) : ticket.serviceDate;
      // Capture timestamps carry a time; rental periods are calendar dates.
      if (!Number.isFinite(+deployed) || deployed.toISOString().slice(0, 10) > periodEnd.toISOString().slice(0, 10)) continue;
      if (item.serial?.trim()) manual.push(`Equipment: ${item.type?.trim() || 'Equipment'} - ${item.serial.trim()}`);
    }
  }
  const saved = snapshot as { periodStart?: string; periodEnd?: string; lines?: unknown } | null;
  const savedEquipment = saved?.periodStart === periodStart.toISOString().slice(0, 10)
    && saved?.periodEnd === periodEnd.toISOString().slice(0, 10) && Array.isArray(saved.lines)
    ? saved.lines.filter((line): line is string => typeof line === 'string' && line.startsWith('Equipment: ')) : [];
  return [
    `Rental dates: ${format(periodStart)} to ${format(periodEnd)}`,
    ...[...new Set([...equipment, ...manual, ...savedEquipment])].sort((a, b) => a.localeCompare(b)),
  ];
}

/** Associate scanned equipment with its charge before rendering either QB document type. */
export function rentalInvoiceLineNotes(
  periodStart: Date | null,
  periodEnd: Date | null,
  items: Array<Parameters<typeof rentalInvoiceNoteLines>[2][number] & {
    id?: string; productId?: string; replacesItemId?: string | null;
    product: { name: string; category?: string | null; qbItemListId?: string | null; qbItemFullName?: string | null };
  }>,
  lines: Array<{
    description: string; productId?: string | null; sourceRentalItemId?: string | null;
    sourceTicketId?: string | null; qbItemListId?: string | null; qbItemFullName?: string | null;
  }>,
  composition: RentalComposition | null,
  tickets: Array<{ serviceDate: Date; customData: unknown }> = [],
  snapshot?: unknown,
): string[][] {
  const notes = lines.map(() => [] as string[]);
  if (!periodStart || !periodEnd) return notes;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const eligible = lines.map((line, index) => ({ ...line, index }))
    .filter(line => !line.sourceTicketId);
  const pkg = composition?.bomPackage;
  const packageLine = eligible.find(line => pkg?.productId && line.productId === pkg.productId)
    || eligible.find(line => pkg?.label && normalize(line.description).includes(normalize(pkg.label)))
    || eligible.find(line => /\bpackage\b/i.test(line.description));
  // Dispatch assigns standalone units first, then the package baseline, then
  // extras. Keep that order stable by deployment date and item ID. Replacements
  // inherit the outgoing unit's slot so a swap does not become an overage.
  const slots = new Map<string, typeof items>();
  const allItems = [...items];
  // Manual deployments and swept snapshots also carry customer-facing serials.
  // Preserve those inputs when moving the existing roster underneath charges.
  for (const note of rentalInvoiceNoteLines(periodStart, periodEnd, [], tickets, snapshot).slice(1)) {
    const text = note.replace(/^Equipment: /, '');
    const separator = text.indexOf(' - ');
    if (separator < 0) continue;
    const name = text.slice(0, separator);
    const serialNumber = text.slice(separator + 3);
    if (allItems.some(item => item.serializedEquipment.serialNumber === serialNumber)) continue;
    const category = composition?.bom?.find(row => normalize(row.label).includes(normalize(name)))?.equipmentCategory;
    allItems.push({ product: { name, category }, serializedEquipment: { serialNumber },
      deployedDate: periodStart, returnedDate: null });
  }
  const ordered = allItems.sort((a, b) => +a.deployedDate - +b.deployedDate
    || (a.id || a.serializedEquipment.serialNumber).localeCompare(b.id || b.serializedEquipment.serialNumber));
  for (const item of ordered) {
    const equipmentNote = rentalInvoiceNoteLines(periodStart, periodEnd, [item])[1];
    const category = item.product.category;
    const key = category || item.productId || item.product.name;
    const categorySlots = slots.get(key) || [];
    let slot = item.replacesItemId ? categorySlots.findIndex(previous => previous.id === item.replacesItemId) : -1;
    if (slot < 0) slot = categorySlots.findIndex(previous => previous.returnedDate && previous.returnedDate < item.deployedDate);
    if (slot < 0) slot = categorySlots.length;
    categorySlots[slot] = item;
    slots.set(key, categorySlots);
    if (!equipmentNote) continue;
    const baseline = (composition?.bom || []).filter(row => category
      ? row.equipmentCategory === category : row.productId === item.productId)
      .reduce((sum, row) => sum + (row.qty ?? 1), 0);
    const standalone = [...(composition?.gasMonitors || []), ...(composition?.other || [])]
      .filter(row => row.productId === item.productId)
      .reduce((sum, row) => sum + (row.qty ?? 1), 0);
    const extra = (composition?.bomExtras || []).find(row => category
      ? row.equipmentCategory === category : row.productId === item.productId);
    const extraLine = extra && (eligible.find(line => extra.productId && line.productId === extra.productId)
      || eligible.find(line => normalize(line.description.split('\n')[0]).includes(normalize(extra.label))));
    const allocated = packageLine && (baseline > 0 || extra) && slot >= standalone
      ? (slot < standalone + baseline ? packageLine : extraLine || packageLine)
      : undefined;
    const target = eligible.find(line => item.id && line.sourceRentalItemId === item.id)
      || allocated
      || eligible.find(line => item.productId && line.productId === item.productId)
      || eligible.find(line => (item.product.qbItemListId && line.qbItemListId === item.product.qbItemListId)
        || (item.product.qbItemFullName && line.qbItemFullName === item.product.qbItemFullName))
      || eligible.find(line => normalize(item.product.name) && normalize(line.description.split('\n')[0]).includes(normalize(item.product.name)))
      || packageLine
      || eligible.find(line => /trailer/i.test(item.product.name) && /trailer/i.test(line.description))
      || eligible.find(line => /^Rental\b/i.test(line.description))
      || (eligible.length === 1 ? eligible[0] : undefined);
    if (target) {
      const label = equipmentNote.replace(/^Equipment: /, '').replace(' - ', ' #');
      if (!notes[target.index].includes(label)) notes[target.index].push(label);
    }
  }
  return notes.map(rows => rows.sort((a, b) => a.localeCompare(b)));
}
