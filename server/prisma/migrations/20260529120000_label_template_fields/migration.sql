-- Expand the default 2"x2" shop label (Zebra ZD411, 203 dpi -> 406x406 dots)
-- to the Canva layout: customer (large, centered) over a job# / intake-date
-- row, a work-type shorthand line ("FEX RECHARGE"), a "Unit N of M" line, and
-- the QR deep-link centered below.
--
-- New template variables (populated in printQueue.ts): intakeDate, workType,
-- unitLine. ${pieceCount} is retired from the layout (the order-level labels
-- now render their count through ${unitLine}).
--
--   ^FO4,10   customer name   36pt, centered, wraps to 2 lines
--   ^FO12,92  job #           28pt, left   (same row as date)
--   ^FO12,92  intake date     28pt, right-aligned in the same row
--   ^FO12,130 work type       30pt
--   ^FO12,168 unit line       30pt
--   ^FO120,204 QR             model 2, mag 5

UPDATE "label_templates"
   SET "template" = E'^XA\n^PW406\n^LL406\n^FO4,10^A0N,36,36^FB398,2,0,C^FD${customerName}^FS\n^FO12,92^A0N,28,28^FD${workOrderNumber}^FS\n^FO12,92^A0N,28,28^FB382,1,0,R^FD${intakeDate}^FS\n^FO12,130^A0N,30,30^FB382,1,0,L^FD${workType}^FS\n^FO12,168^A0N,30,30^FB382,1,0,L^FD${unitLine}^FS\n^FO120,204^BQN,2,5^FDLA,${qrPayload}^FS\n^XZ',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "name" = 'ticket_default';
