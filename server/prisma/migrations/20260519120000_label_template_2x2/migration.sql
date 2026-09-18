-- Rebuild the default label for a 2" x 2" direct-thermal label on the
-- Zebra ZD411 (203 dpi → 406 x 406 dots; the unit's media tops out at 2.2").
-- The old layout placed the QR at x≈2.07" — off the edge of a 2" label.
--
-- The tag now carries only what isn't already in the ticket:
--   customer (company), ticket #, piece count, and a QR deep-link to the ticket.

UPDATE "label_templates"
   SET "template" = E'^XA\n^PW406\n^LL406\n^FO12,14^A0N,30,30^FB382,2,0,L^FD${customerName}^FS\n^FO12,92^A0N,46,46^FD${workOrderNumber}^FS\n^FO12,146^A0N,26,26^FD${pieceCount} PCS^FS\n^FO100,182^BQN,2,5^FDLA,${qrPayload}^FS\n^XZ',
       "updated_at" = CURRENT_TIMESTAMP
 WHERE "name" = 'ticket_default';
