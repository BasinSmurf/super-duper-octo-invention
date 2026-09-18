-- Item-level labels now carry the unit's own serial number, and SCBA
-- sub-component labels additionally say which parent assembly they belong to
-- ("PART OF <case serial>"). Two new template vars (itemSerial, parentLine) —
-- both render blank on order-level packet/bin labels, so the same template
-- serves every label type.
--
-- Layout (600x600 dots @ 300dpi ZD411), top to bottom:
--   customer name        50pt, centered, up to 2 lines
--   job # / intake date  38pt (same row, left + right)
--   work-type shorthand  41pt
--   unit line            34pt
--   ITEM SERIAL          44pt  (the read-off-the-tag key — biggest body text)
--   part-of line         32pt  ("PART OF <parent serial>", children only)
--   QR deep-link         model 2, mag 6 (was 7 — shrunk one step to make room)
--   footer               "Serviced by Basin Safety" 32pt / phone 30pt
UPDATE "label_templates"
   SET "template" = E'^XA\n^PW600\n^LL600\n^FO0,6^A0N,50,50^FB600,2,0,C^FD${customerName}^FS\n^FO21,112^A0N,38,38^FD${workOrderNumber}^FS\n^FO0,112^A0N,38,38^FB579,1,0,R^FD${intakeDate}^FS\n^FO21,156^A0N,41,41^FB559,1,0,L^FD${workType}^FS\n^FO21,202^A0N,34,34^FB559,1,0,L^FD${unitLine}^FS\n^FO21,240^A0N,44,44^FB559,1,0,L^FD${itemSerial}^FS\n^FO21,290^A0N,32,32^FB559,1,0,L^FD${parentLine}^FS\n^FO201,328^BQN,2,6^FDLA,${qrPayload}^FS\n^FO0,532^A0N,32,32^FB600,1,0,C^FDServiced by Basin Safety^FS\n^FO0,566^A0N,30,30^FB600,1,0,C^FD(701) 572-8140^FS\n^XZ',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "name" = 'ticket_default';
