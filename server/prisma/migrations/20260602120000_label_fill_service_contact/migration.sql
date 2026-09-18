-- D: Make the 2"x2" shop label use the whole sticker and add a service-contact
-- footer so a unit found in the field shows who to call to re-service it.
--
-- Layout (406x406 dots @ 203dpi):
--   customer name   34pt, centered, up to 2 lines
--   job #  /  intake date   26pt  (same row, left + right)
--   work-type shorthand     28pt
--   unit line               26pt
--   QR deep-link            model 2, mag 5, centered
--   "Serviced by Basin Safety"  24pt centered
--   "(701) 572-8140"            22pt centered
--
-- Template vars unchanged (customerName, workOrderNumber, intakeDate, workType,
-- unitLine, qrPayload); the footer is static text.
UPDATE "label_templates"
   SET "template" = E'^XA\n^PW406\n^LL406\n^FO0,4^A0N,34,34^FB406,2,0,C^FD${customerName}^FS\n^FO14,76^A0N,26,26^FD${workOrderNumber}^FS\n^FO0,76^A0N,26,26^FB392,1,0,R^FD${intakeDate}^FS\n^FO14,106^A0N,28,28^FB378,1,0,L^FD${workType}^FS\n^FO14,138^A0N,26,26^FB378,1,0,L^FD${unitLine}^FS\n^FO110,168^BQN,2,5^FDLA,${qrPayload}^FS\n^FO0,356^A0N,24,24^FB406,1,0,C^FDServiced by Basin Safety^FS\n^FO0,382^A0N,22,22^FB406,1,0,C^FD(701) 572-8140^FS\n^XZ',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "name" = 'ticket_default';
