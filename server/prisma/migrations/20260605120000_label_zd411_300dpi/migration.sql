-- The shop ZD411 printers were swapped from 203 dpi to 300 dpi units. Same
-- physical 2"x2" stock, but 2" is now 600 dots instead of 406, so every dot
-- coordinate, font height, field-block width, and the QR magnification has to
-- scale by 300/203 (~1.478) or the layout prints crammed into the top-left
-- corner at ~2/3 size.
--
-- Layout (600x600 dots @ 300dpi) — same as the 203dpi version, scaled up:
--   customer name   50pt, centered, up to 2 lines
--   job #  /  intake date   38pt  (same row, left + right)
--   work-type shorthand     41pt
--   unit line               38pt
--   QR deep-link            model 2, mag 7 (was 5), centered
--   "Serviced by Basin Safety"  35pt centered
--   "(701) 572-8140"            32pt centered
--
-- Template vars unchanged (customerName, workOrderNumber, intakeDate, workType,
-- unitLine, qrPayload); the footer is static text.
UPDATE "label_templates"
   SET "template" = E'^XA\n^PW600\n^LL600\n^FO0,6^A0N,50,50^FB600,2,0,C^FD${customerName}^FS\n^FO21,112^A0N,38,38^FD${workOrderNumber}^FS\n^FO0,112^A0N,38,38^FB579,1,0,R^FD${intakeDate}^FS\n^FO21,156^A0N,41,41^FB559,1,0,L^FD${workType}^FS\n^FO21,204^A0N,38,38^FB559,1,0,L^FD${unitLine}^FS\n^FO166,250^BQN,2,7^FDLA,${qrPayload}^FS\n^FO0,526^A0N,35,35^FB600,1,0,C^FDServiced by Basin Safety^FS\n^FO0,565^A0N,32,32^FB600,1,0,C^FD(701) 572-8140^FS\n^XZ',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "name" = 'ticket_default';
